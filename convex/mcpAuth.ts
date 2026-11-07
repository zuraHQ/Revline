import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { requireOwner } from './lib/auth';
import { requireEditorAccess } from './lib/billing_access';
import { mcpOrigins, publicMcpOrigin } from './lib/mcp_origin';
import { CONSENT_APPROVAL_TTL_MS, signConsentApproval, verifyConsentApproval } from '../lib/mcp/consent-approval';

// OAuth 2.1 for the MCP connector: public clients, PKCE S256 only, hashed tokens.
const CODE_TTL = 10 * 60_000, ACCESS_TTL = 60 * 60_000, REFRESH_TTL = 60 * 24 * 60 * 60_000;
const CALLS_PER_MINUTE = 120, REFRESH_RETRY_GRACE = 30_000;
export const MCP_PLAN_ERROR = 'The Revline MCP connector needs an active Revline plan.';

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function sha256(text: string) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))); }
const randomValue = (prefix: string) => `${prefix}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
// Editors that register a bare app scheme rather than a reverse-domain one.
const APP_SCHEMES = ['cursor:', 'vscode:', 'vscode-insiders:', 'windsurf:', 'zed:'];

/** https, loopback http or a private-use app scheme (RFC 8252 §7.1). */
export function validRedirectUri(value: string) {
  if (value.length > 2000) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.includes(url.hostname);
  return APP_SCHEMES.includes(url.protocol) || /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

/** Redirects that belong to Claude or ChatGPT themselves, or stay on this computer. */
function trustedRedirect(value: string) {
  const url = new URL(value);
  return (url.protocol === 'https:' && ['claude.ai', 'claude.com', 'chatgpt.com'].includes(url.hostname)) || (url.protocol === 'http:' && LOOPBACK.includes(url.hostname));
}

async function requireConnectorAccess(ctx: QueryCtx | MutationCtx, ownerId: string) {
  // MCP is included with Pro; editor access is the only requirement.
  await requireEditorAccess(ctx, ownerId);
}

async function clientFor(ctx: QueryCtx | MutationCtx, clientId: string, redirectUri: string) {
  const client = await ctx.db.query('mcpClients').withIndex('by_clientId', q => q.eq('clientId', clientId)).unique();
  if (!client || !client.redirectUris.includes(redirectUri)) throw new ConvexError('This app is not registered for that redirect address.');
  return client;
}

async function issueTokens(ctx: MutationCtx, ownerId: string, grantId: string, clientId: string, label: string) {
  const access = randomValue('rvl_at_'), refresh = randomValue('rvl_rt_'), now = Date.now();
  await ctx.db.insert('mcpTokens', { tokenHash: await sha256(access), kind: 'access', ownerId, grantId, clientId, label, createdAt: now, expiresAt: now + ACCESS_TTL });
  await ctx.db.insert('mcpTokens', { tokenHash: await sha256(refresh), kind: 'refresh', ownerId, grantId, clientId, label, createdAt: now, expiresAt: now + REFRESH_TTL });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'revline' };
}

/** Only live tokens are read, so a connection's newest tokens are always reached. */
async function revokeGrant(ctx: MutationCtx, grantId: string) {
  const now = Date.now();
  for (const token of await ctx.db.query('mcpTokens').withIndex('by_grant_revoked', q => q.eq('grantId', grantId).eq('revokedAt', undefined)).take(100)) await ctx.db.patch(token._id, { revokedAt: now });
}

const oauthError = (error: string, description: string) => ({ error, error_description: description });
const tokenResult = v.union(
  v.object({ access_token: v.string(), token_type: v.string(), expires_in: v.number(), refresh_token: v.string(), scope: v.string() }),
  v.object({ error: v.string(), error_description: v.string() }),
);

export const registerClient = internalMutation({ args: { clientName: v.string(), redirectUris: v.array(v.string()), source: v.string() }, returns: v.union(v.object({ clientId: v.string(), createdAt: v.number() }), v.object({ error: v.union(v.literal('invalid_redirect_uri'), v.literal('rate_limited')) })), handler: async (ctx, args) => {
  if (!args.redirectUris.length || args.redirectUris.length > 10 || !args.redirectUris.every(validRedirectUri)) return { error: 'invalid_redirect_uri' as const };
  if (!await withinLimit(ctx, `register:${args.source}`, 10)) return { error: 'rate_limited' as const };
  const clientId = randomValue('rvl_client_'), createdAt = Date.now();
  await ctx.db.insert('mcpClients', { clientId, clientName: args.clientName.trim().slice(0, 100) || 'MCP client', redirectUris: [...new Set(args.redirectUris)], createdAt });
  return { clientId, createdAt };
}});

export const checkAuthorizeRequest = internalQuery({ args: { clientId: v.string(), redirectUri: v.string() }, returns: v.boolean(), handler: async (ctx, args) => {
  const client = await ctx.db.query('mcpClients').withIndex('by_clientId', q => q.eq('clientId', args.clientId)).unique();
  return !!client && client.redirectUris.includes(args.redirectUri);
}});

export const exchangeCode = internalMutation({ args: { code: v.string(), clientId: v.string(), redirectUri: v.string(), codeVerifier: v.string(), resource: v.optional(v.string()) }, returns: tokenResult, handler: async (ctx, args) => {
  const codeHash = await sha256(args.code);
  const row = await ctx.db.query('mcpAuthCodes').withIndex('by_codeHash', q => q.eq('codeHash', codeHash)).unique();
  if (!row) return oauthError('invalid_grant', 'The authorization code is invalid or was already used.');
  // A replayed code may have leaked: end the connection it already created.
  if (row.redeemedGrantId !== undefined) { await revokeGrant(ctx, row.redeemedGrantId); return oauthError('invalid_grant', 'The authorization code was already used.'); }
  return redeem(ctx, row, args);
}});

async function redeem(ctx: MutationCtx, row: Doc<'mcpAuthCodes'>, args: { clientId: string; redirectUri: string; codeVerifier: string; resource?: string }) {
  const grantId = randomValue('grant_');
  // Single use: the tombstone keeps the code unusable until it expires.
  await ctx.db.patch(row._id, { redeemedGrantId: grantId });
  if (row.expiresAt < Date.now() || row.clientId !== args.clientId || row.redirectUri !== args.redirectUri) return oauthError('invalid_grant', 'The authorization code is invalid or expired.');
  if (args.resource !== undefined && row.resource !== undefined && args.resource.replace(/\/$/, '') !== row.resource) return oauthError('invalid_target', 'This code was issued for a different server.');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(args.codeVerifier) || await sha256(args.codeVerifier) !== row.codeChallenge) return oauthError('invalid_grant', 'PKCE verification failed.');
  try { await requireConnectorAccess(ctx, row.ownerId); } catch { return oauthError('access_denied', MCP_PLAN_ERROR); }
  const client = await ctx.db.query('mcpClients').withIndex('by_clientId', q => q.eq('clientId', row.clientId)).unique();
  return issueTokens(ctx, row.ownerId, grantId, row.clientId, client?.clientName ?? 'MCP client');
}

export const refreshTokens = internalMutation({ args: { refreshToken: v.string(), clientId: v.string() }, returns: tokenResult, handler: async (ctx, args) => {
  const hash = await sha256(args.refreshToken);
  const token = await ctx.db.query('mcpTokens').withIndex('by_tokenHash', q => q.eq('tokenHash', hash)).unique();
  if (!token || token.kind !== 'refresh' || token.clientId !== args.clientId) return oauthError('invalid_grant', 'The refresh token is invalid.');
  if (token.revokedAt !== undefined) {
    // A rotated refresh token presented again means it leaked: end the whole
    // connection. A retry within seconds is a lost response, not a leak.
    if (Date.now() - token.revokedAt > REFRESH_RETRY_GRACE) await revokeGrant(ctx, token.grantId);
    return oauthError('invalid_grant', 'The refresh token was already used.');
  }
  if ((token.expiresAt ?? 0) < Date.now()) return oauthError('invalid_grant', 'The refresh token expired. Connect again.');
  try { await requireConnectorAccess(ctx, token.ownerId); } catch { return oauthError('access_denied', MCP_PLAN_ERROR); }
  // Rotation retires every live token of the connection, including its old access token.
  await revokeGrant(ctx, token.grantId);
  return issueTokens(ctx, token.ownerId, token.grantId, args.clientId, token.label);
}});

export const revokeToken = internalMutation({ args: { token: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const tokenHash = await sha256(args.token);
  const token = await ctx.db.query('mcpTokens').withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash)).unique();
  if (token && token.kind !== 'personal') await revokeGrant(ctx, token.grantId);
  return null;
}});

/** A fixed one-minute window per key; false once the key used its allowance. */
async function withinLimit(ctx: MutationCtx, key: string, limit: number, count = 1) {
  const now = Date.now(), usage = await ctx.db.query('mcpUsage').withIndex('by_owner', q => q.eq('ownerId', key)).unique();
  if (!usage) { await ctx.db.insert('mcpUsage', { ownerId: key, windowStart: now, calls: count }); return count <= limit; }
  if (now - usage.windowStart >= 60_000) { await ctx.db.patch(usage._id, { windowStart: now, calls: count }); return count <= limit; }
  if (usage.calls + count > limit) return false;
  await ctx.db.patch(usage._id, { calls: usage.calls + count });
  return true;
}

/** Resolve a bearer token to its owner; counts tool calls against a per-minute limit. */
export const authenticate = internalMutation({ args: { token: v.string(), calls: v.number(), bridge: v.optional(v.boolean()) }, returns: v.union(v.object({ ownerId: v.string(), clientName: v.string(), grantId:v.string() }), v.object({ error: v.union(v.literal('invalid_token'), v.literal('plan'), v.literal('rate_limited')) })), handler: async (ctx, args) => {
  const hash = await sha256(args.token), now = Date.now();
  const token = await ctx.db.query('mcpTokens').withIndex('by_tokenHash', q => q.eq('tokenHash', hash)).unique();
  if (!token || token.kind === 'refresh' || token.revokedAt !== undefined || (token.expiresAt !== undefined && token.expiresAt < now)) return { error: 'invalid_token' as const };
  // A grant key only works for the Cloudflare MCP server, through its signed bridge (convex/mcpBridgeHttp.ts).
  if (token.kind === 'grant' && !args.bridge) return { error: 'invalid_token' as const };
  try { await requireConnectorAccess(ctx, token.ownerId); } catch { return { error: 'plan' as const }; }
  if (token.lastUsedAt === undefined || now - token.lastUsedAt > 60_000) await ctx.db.patch(token._id, { lastUsedAt: now });
  if (args.calls > 0 && !await withinLimit(ctx, token.ownerId, CALLS_PER_MINUTE, args.calls)) return { error: 'rate_limited' as const };
  return { ownerId: token.ownerId, clientName: token.label, grantId:token.grantId };
}});

// Connections approved through the Cloudflare MCP server (cloudflare/mcp). Its OAuth provider issues and rotates the
// client's tokens; Convex keeps one "grant" row per connection whose key only that Worker holds. Every MCP request
// authenticates that key here, so plan access, rate limits, the connector settings list and revocation stay in Convex.
const GRANT_PENDING_MS = 15 * 60_000;

/** Single use, through the runner's nonce table (convex/agentRunner.ts prunes it). */
async function useNonce(ctx: MutationCtx, nonce: string, expiresAt: number) {
  if (await ctx.db.query('agentRunnerNonces').withIndex('by_nonce', q => q.eq('nonce', nonce)).first()) return false;
  await ctx.db.insert('agentRunnerNonces', { nonce, expiresAt });
  return true;
}

export const createGrant = internalMutation({ args: { approval: v.string(), handle: v.string(), clientId: v.string(), clientName: v.string() }, returns: v.union(v.object({ ownerId: v.string(), grantId: v.string(), grantKey: v.string() }), v.object({ error: v.union(v.literal('invalid_approval'), v.literal('plan')) })), handler: async (ctx, args) => {
  const approval = await verifyConsentApproval(process.env.MCP_BRIDGE_SECRET, args.approval);
  if (!approval || approval.handle !== args.handle || !await useNonce(ctx, `consent:${approval.nonce}`, approval.expires + CONSENT_APPROVAL_TTL_MS)) return { error: 'invalid_approval' as const };
  try { await requireConnectorAccess(ctx, approval.ownerId); } catch { return { error: 'plan' as const }; }
  const grantKey = randomValue('rvl_gk_'), grantId = randomValue('grant_'), now = Date.now();
  // Pending until the client redeems its code (touchGrant); expireGrant retires it if that never happens.
  const id = await ctx.db.insert('mcpTokens', { tokenHash: await sha256(grantKey), kind: 'grant', ownerId: approval.ownerId, grantId, clientId: args.clientId.slice(0, 200), label: args.clientName.trim().slice(0, 100) || 'MCP client', createdAt: now, expiresAt: now + GRANT_PENDING_MS });
  await ctx.scheduler.runAt(now + GRANT_PENDING_MS, internal.mcpAuth.expireGrant, { id });
  return { ownerId: approval.ownerId, grantId, grantKey };
}});

/** Revokes a grant once it is past its expiry, so prune removes it like any dead token; a grant still in use waits again. */
export const expireGrant = internalMutation({ args: { id: v.id('mcpTokens') }, returns: v.null(), handler: async (ctx, args) => {
  const token = await ctx.db.get(args.id);
  if (!token || token.kind !== 'grant' || token.revokedAt !== undefined) return null;
  if ((token.expiresAt ?? 0) <= Date.now()) await ctx.db.patch(token._id, { revokedAt: Date.now() });
  else await ctx.scheduler.runAt(token.expiresAt!, internal.mcpAuth.expireGrant, args);
  return null;
}});

/** On each code exchange and refresh: a live grant slides to the refresh lifetime; false once it was revoked or expired. */
export const touchGrant = internalMutation({ args: { grantKey: v.string() }, returns: v.boolean(), handler: async (ctx, args) => {
  const tokenHash = await sha256(args.grantKey), now = Date.now();
  const token = await ctx.db.query('mcpTokens').withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash)).unique();
  if (!token || token.kind !== 'grant' || token.revokedAt !== undefined || (token.expiresAt ?? 0) < now) return false;
  if ((token.expiresAt ?? 0) < now + REFRESH_TTL - 60 * 60_000) await ctx.db.patch(token._id, { expiresAt: now + REFRESH_TTL });
  return true;
}});

// Signed-in pages: the consent screen and the profile's connector settings.

export const authorizationRequest = query({ args: { clientId: v.string(), redirectUri: v.string() }, returns: v.union(v.object({ ok: v.literal(true), clientName: v.string(), redirectHost: v.string(), trusted: v.boolean(), allowed: v.boolean() }), v.object({ ok: v.literal(false), message: v.string() })), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  const client = await ctx.db.query('mcpClients').withIndex('by_clientId', q => q.eq('clientId', args.clientId)).unique();
  if (!client || !client.redirectUris.includes(args.redirectUri)) return { ok: false as const, message: 'This app is not registered with Revline. Remove the connector and add it again.' };
  const allowed = await requireConnectorAccess(ctx, ownerId).then(() => true, () => false);
  const url = new URL(args.redirectUri);
  return { ok: true as const, clientName: client.clientName, redirectHost: url.host || url.protocol.replace(/:$/, ''), trusted: trustedRedirect(args.redirectUri), allowed };
}});

/** The consent page for a Cloudflare OAuth request: what it may show about the redirect, and whether this account may connect. */
export const consentAccess = query({ args: { redirectUri: v.string() }, returns: v.union(v.object({ ok: v.literal(true), redirectHost: v.string(), trusted: v.boolean(), allowed: v.boolean() }), v.object({ ok: v.literal(false), message: v.string() })), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  if (!validRedirectUri(args.redirectUri)) return { ok: false as const, message: 'This connection link is incomplete. Start again from the app you are connecting.' };
  const allowed = await requireConnectorAccess(ctx, ownerId).then(() => true, () => false);
  const url = new URL(args.redirectUri);
  return { ok: true as const, redirectHost: url.host || url.protocol.replace(/:$/, ''), trusted: trustedRedirect(args.redirectUri), allowed };
}});

/** The signed-in user approves one consent handle; the page posts the result to the MCP server's /oauth/authorize. */
export const approveConsent = mutation({ args: { handle: v.string() }, returns: v.object({ approval: v.string() }), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  await requireConnectorAccess(ctx, ownerId);
  const secret = process.env.MCP_BRIDGE_SECRET;
  if (!secret) throw new ConvexError('Connecting apps is not configured on this server.');
  if (!args.handle || args.handle.length > 500) throw new ConvexError('This connection link is incomplete. Start again from the app you are connecting.');
  return { approval: await signConsentApproval(secret, { ownerId, handle: args.handle, nonce: crypto.randomUUID(), expires: Date.now() + CONSENT_APPROVAL_TTL_MS }) };
}});

export const approve = mutation({ args: { clientId: v.string(), redirectUri: v.string(), codeChallenge: v.string(), codeChallengeMethod: v.string(), state: v.optional(v.string()), resource: v.optional(v.string()) }, returns: v.object({ redirectTo: v.string() }), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  await requireConnectorAccess(ctx, ownerId);
  await clientFor(ctx, args.clientId, args.redirectUri);
  if (args.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)) throw new ConvexError('This app must use PKCE (S256).');
  const resource = args.resource === undefined ? undefined : args.resource.replace(/\/$/, '');
  if (resource !== undefined && !mcpOrigins().some(origin => resource === `${origin}/mcp`)) throw new ConvexError('This authorization is for a different server.');
  const code = randomValue('rvl_code_');
  await ctx.db.insert('mcpAuthCodes', { codeHash: await sha256(code), clientId: args.clientId, ownerId, redirectUri: args.redirectUri, codeChallenge: args.codeChallenge, ...(resource ? { resource } : {}), expiresAt: Date.now() + CODE_TTL });
  const redirect = new URL(args.redirectUri);
  redirect.searchParams.set('code', code);
  if (args.state !== undefined) redirect.searchParams.set('state', args.state);
  // The issuer is the address the client discovered us at, which its resource names.
  redirect.searchParams.set('iss', resource ? resource.replace(/\/mcp$/, '') : publicMcpOrigin());
  return { redirectTo: redirect.toString() };
}});

export const connector = query({ args: {}, returns: v.object({ mcpUrl: v.string(), allowed: v.boolean(), connections: v.array(v.object({ grantId: v.string(), label: v.string(), kind: v.union(v.literal('app'), v.literal('personal')), createdAt: v.number(), lastUsedAt: v.optional(v.number()) })) }), handler: async (ctx) => {
  const ownerId = await requireOwner(ctx);
  const allowed = await requireConnectorAccess(ctx, ownerId).then(() => true, () => false);
  const now = Date.now(), grants = new Map<string, { grantId: string; label: string; kind: 'app' | 'personal'; createdAt: number; lastUsedAt?: number }>();
  // Revoked tokens stay 30 days for refresh reuse detection; read only the live ones.
  for (const token of await ctx.db.query('mcpTokens').withIndex('by_owner_revoked', q => q.eq('ownerId', ownerId).eq('revokedAt', undefined)).order('desc').take(500)) {
    if (token.revokedAt !== undefined || (token.expiresAt !== undefined && token.expiresAt < now)) continue;
    const current = grants.get(token.grantId);
    const lastUsedAt = Math.max(current?.lastUsedAt ?? 0, token.lastUsedAt ?? 0) || undefined;
    grants.set(token.grantId, { grantId: token.grantId, label: token.label, kind: token.kind === 'personal' ? 'personal' : 'app', createdAt: Math.min(current?.createdAt ?? token.createdAt, token.createdAt), ...(lastUsedAt ? { lastUsedAt } : {}) });
  }
  return { mcpUrl: `${publicMcpOrigin()}/mcp`, allowed, connections: [...grants.values()].sort((a, b) => b.createdAt - a.createdAt) };
}});

export const createPersonalToken = mutation({ args: { label: v.string() }, returns: v.object({ token: v.string() }), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  await requireConnectorAccess(ctx, ownerId);
  const active = (await ctx.db.query('mcpTokens').withIndex('by_owner_revoked', q => q.eq('ownerId', ownerId).eq('revokedAt', undefined)).take(500)).filter(token => token.kind === 'personal');
  if (active.length >= 10) throw new ConvexError('Revoke an existing token before creating another (10 maximum).');
  const token = randomValue('rvl_pat_');
  await ctx.db.insert('mcpTokens', { tokenHash: await sha256(token), kind: 'personal', ownerId, grantId: randomValue('grant_'), label: args.label.trim().slice(0, 60) || 'Personal token', createdAt: Date.now() });
  return { token };
}});

export const revokeConnection = mutation({ args: { grantId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx);
  const token = await ctx.db.query('mcpTokens').withIndex('by_grant', q => q.eq('grantId', args.grantId)).first();
  if (!token || token.ownerId !== ownerId) throw new ConvexError('Connection not found.');
  await revokeGrant(ctx, args.grantId);
  return null;
}});

const DAY = 24 * 60 * 60_000;
/** Daily: drop dead tokens, used or expired codes, apps that never connected and stale counters. */
export const prune = internalMutation({ args: {}, returns: v.null(), handler: async (ctx) => {
  const now = Date.now();
  for (const token of await ctx.db.query('mcpTokens').withIndex('by_revokedAt', q => q.gt('revokedAt', 0).lt('revokedAt', now - 30 * DAY)).take(500)) await ctx.db.delete(token._id);
  for (const code of await ctx.db.query('mcpAuthCodes').withIndex('by_expiresAt', q => q.lt('expiresAt', now - DAY)).take(500)) await ctx.db.delete(code._id);
  for (const client of await ctx.db.query('mcpClients').withIndex('by_createdAt', q => q.lt('createdAt', now - 7 * DAY)).take(200)) {
    if (!await ctx.db.query('mcpTokens').withIndex('by_clientId', q => q.eq('clientId', client.clientId)).first()) await ctx.db.delete(client._id);
  }
  for (const usage of await ctx.db.query('mcpUsage').take(500)) if (usage.windowStart < now - DAY) await ctx.db.delete(usage._id);
  return null;
}});
