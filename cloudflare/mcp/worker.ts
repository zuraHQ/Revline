import { AuthorizationError, OAuthError, OAuthProvider, type OAuthHelpers, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { getAgentByName } from 'agents';
import { McpAgent } from 'agents/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, InitializeRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { env as workerEnv } from 'cloudflare:workers';
import { MCP_INSTRUCTIONS } from '../../lib/mcp/instructions';
import { listMcpResources, readMcpResource } from '../../lib/mcp/resources';
import { MCP_REFERENCE_COMPARISON_BUDGET_MS } from '../../lib/ai/reference-comparison';
import { bridge, forwardToConvex, type Auth, type AuthError, type ToolOutcome } from './bridge';

// Revline's public MCP server: the protocol (one McpAgent Durable Object per MCP session) and the OAuth provider run
// here; the tools, their data and every access decision stay in Convex behind a signed bridge (convex/mcpBridgeHttp.ts).
//
// Connections made before this Worker existed keep working unchanged: their clients (rvl_client_*) and tokens (rvl_*)
// live in Convex, so those OAuth requests go to Convex's own handlers and their bearer tokens are checked there.

/** What the OAuth provider hands the /mcp handler: the credential Convex checks on every request. For a connection
 * approved here it is that connection's grant key (only this Worker holds it); for an older one, its Convex token. */
type Props = { credential: string };
type Env = Cloudflare.Env & { OAUTH_PROVIDER: OAuthHelpers };

const LEGACY_CLIENT = 'rvl_client_', LEGACY_TOKEN = 'rvl_', GRANT_KEY = 'rvl_gk_';
/** Set by this Worker for the session Durable Object on every request; a client's own copy is dropped first. */
const AUTH_HEADER = 'x-revline-mcp-auth';
const DAY = 24 * 60 * 60;

const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const rpcError = (code: number, message: string, status: number, headers: Record<string, string> = {}) => json({ jsonrpc: '2.0', id: null, error: { code, message } }, status, headers);
const withCors = (response: Response) => { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(cors)) headers.set(key, value); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); };
const challenge = (error?: string) => `Bearer resource_metadata="${workerEnv.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}`;
// Same session-id rule as convex/mcpHttp.ts.
const validSession = (value: string) => /^[\x21-\x7e]{1,256}$/.test(value);

// Same answers as the Convex server for a credential Convex refused.
function refused(auth: AuthError) {
  if (auth.error === 'invalid_token') return rpcError(-32001, 'This Revline connection expired or was revoked. Connect again.', 401, { 'WWW-Authenticate': challenge('invalid_token') });
  if (auth.error === 'rate_limited') return rpcError(-32002, 'Too many tool calls. Wait a minute and retry.', 429, { 'Retry-After': '60' });
  return rpcError(-32003, 'The Revline MCP connector is part of the Ultra plan.', 403);
}

type CallAuth = { credential: string; comparisonDeadline: number };
function callAuth(headers: Record<string, string | string[] | undefined> | undefined): CallAuth | null {
  const value = headers?.[AUTH_HEADER];
  if (typeof value !== 'string') return null;
  try { const auth = JSON.parse(decodeURIComponent(value)) as CallAuth; return typeof auth.credential === 'string' && typeof auth.comparisonDeadline === 'number' ? auth : null; } catch { return null; }
}

// One stable catalog for every session: clients that never re-fetch tools/list (Codex ignores list_changed) still
// hold every tool. Lane, capability, owner and task access are enforced by Convex on each call instead.
// Refreshed every few minutes so a Convex deploy's new tools reach new sessions on a warm isolate.
const CATALOG_TTL_MS = 5 * 60_000;
let toolCatalog: { tools: Promise<Tool[]>; at: number } | undefined;

/** One MCP session. It speaks the protocol and keeps the session's streams; each tool call runs in Convex as the
 * credential the Worker authenticated for that request, under the same connection identity the Convex server uses. */
export class RevlineMcp extends McpAgent<Env, unknown, Record<string, never>> {
  server = new Server({ name: 'revline', title: 'Revline', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS });

  async init() {
    const env = this.env;
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => listMcpResources());
    this.server.setRequestHandler(ReadResourceRequestSchema, async request => readMcpResource(request.params.uri));
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!toolCatalog || Date.now() - toolCatalog.at > CATALOG_TTL_MS) {
        const entry = { at: Date.now(), tools: bridge<{ tools: Tool[] }>(env, { op: 'listTools' }).then(reply => reply.tools) };
        entry.tools.catch(() => { if (toolCatalog === entry) toolCatalog = undefined; });
        toolCatalog = entry;
      }
      return { tools: await toolCatalog.tools };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const auth = callAuth(extra.requestInfo?.headers);
      if (!auth) return { content: [{ type: 'text' as const, text: 'Sign in to Revline to use this connector.' }], isError: true };
      const reply = await bridge<{ outcome: ToolOutcome } | AuthError | { error: 'session_closed' }>(env, {
        op: 'callTool', credential: auth.credential, sessionId: this.getSessionId(),
        name: request.params.name, arguments: request.params.arguments ?? {}, comparisonDeadline: auth.comparisonDeadline,
      });
      if ('error' in reply) {
        const text = reply.error === 'session_closed' ? 'This MCP session ended. Initialize a new session.' : reply.error === 'rate_limited' ? 'Too many tool calls. Wait a minute and retry.' : reply.error === 'plan' ? 'The Revline MCP connector is part of the Ultra plan.' : 'This Revline connection expired or was revoked. Connect again.';
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
      const outcome = reply.outcome;
      return { content: [{ type: 'text' as const, text: outcome.text }, ...(outcome.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))], ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}), isError: outcome.isError };
    });
  }

  /** Binds this session to the connection that opened it. Another connection's token can never use, stream or
   * resume it. False for a session another connection opened; true for an unknown one, which the transport refuses. */
  async checkGrant(grantId: string, claim: boolean): Promise<boolean> {
    const owner = await this.ctx.storage.get<string>('revline:grant');
    if (owner !== undefined) return owner === grantId;
    if (claim) { await this.ctx.storage.put('revline:grant', grantId); return true; }
    return !await this.getInitializeRequest();
  }
}

const sessions = RevlineMcp.serve('/mcp', { binding: 'MCP_SESSION', corsOptions: { origin: '*', headers: cors['Access-Control-Allow-Headers'], methods: cors['Access-Control-Allow-Methods'], exposeHeaders: cors['Access-Control-Expose-Headers'] } });
const session = (env: Env, sessionId: string) => getAgentByName(env.MCP_SESSION, `streamable-http:${sessionId}`);

/** /mcp, after the OAuth provider accepted the bearer token (or passed an older Convex token through). Convex
 * authenticates the credential on every request, counting tool calls against the per-minute limit, as before. */
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
    try { return await serveMcp(request, env, ctx); }
    catch (error) {
      console.error(`[mcp] ${JSON.stringify({ event: 'request-failed', method: request.method, message: error instanceof Error ? error.message.slice(0, 300) : 'unknown' })}`);
      return rpcError(-32603, 'Revline is unavailable right now. Try again in a moment.', 503, { 'Retry-After': '5' });
    }
  },
};

async function serveMcp(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const credential = ctx.props?.credential;
  if (!credential) return rpcError(-32001, 'Sign in to Revline to use this connector.', 401, { 'WWW-Authenticate': challenge() });
  const comparisonDeadline = Date.now() + MCP_REFERENCE_COMPARISON_BUDGET_MS;
  let method: unknown, clientInfo: { name: string; title?: string; version: string } | undefined;
  if (request.method === 'POST') {
    let body: unknown;
    try { body = await request.clone().json(); } catch { return rpcError(-32700, 'Parse error', 400); }
    // MCP 2025-06-18 removed JSON-RPC batching; one message per request keeps rate limits exact.
    if (Array.isArray(body)) return rpcError(-32600, 'Send one JSON-RPC message per request.', 400);
    method = body && typeof body === 'object' ? (body as { method?: unknown }).method : undefined;
    if (method === 'initialize') { const parsed = InitializeRequestSchema.safeParse(body); if (parsed.success) { const { name, title, version } = parsed.data.params.clientInfo; clientInfo = { name, version, ...(title ? { title } : {}) }; } }
  }
  const sessionId = method === 'initialize' ? null : request.headers.get('Mcp-Session-Id');
  if (sessionId !== null && !validSession(sessionId)) return rpcError(-32600, 'Invalid Mcp-Session-Id.', 400);
  const auth = await bridge<Auth | AuthError>(env, { op: 'authenticate', credential, calls: method === 'tools/call' ? 1 : 0, ...(sessionId ? { sessionId } : {}) });
  if ('error' in auth) return refused(auth);
  if (auth.closed) return rpcError(-32000, 'This MCP session ended. Initialize a new session.', 404);
  if (sessionId && !await (await session(env, sessionId)).checkGrant(auth.grantId, false)) return rpcError(-32001, 'Session not found', 404);
  if (request.method === 'DELETE' && sessionId) await bridge(env, { op: 'close', credential, sessionId });

  // The session object gets this request's credential in memory only: no bearer token, and no props in its storage.
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  headers.set(AUTH_HEADER, encodeURIComponent(JSON.stringify({ credential, comparisonDeadline } satisfies CallAuth)));
  const forwarded = new Request(request, { headers });
  const response = await sessions.fetch(forwarded, env, { waitUntil: promise => ctx.waitUntil(promise), passThroughOnException: () => ctx.passThroughOnException(), props: {} } as ExecutionContext);
  const opened = method === 'initialize' && response.ok ? response.headers.get('mcp-session-id') : null;
  if (opened) {
    await (await session(env, opened)).checkGrant(auth.grantId, true);
    if (clientInfo) await bridge(env, { op: 'initialize', credential, sessionId: opened, clientInfo });
  }
  return withCors(response);
}

const page = (message: string, status: number) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
function authorizationFailure(error: unknown) {
  if (error instanceof AuthorizationError) return error.redirectTo ? Response.redirect(error.redirectTo, 302) : page(`${error.description} Remove and add the Revline connector again.`, 400);
  throw error;
}

/** /oauth/authorize for connections made here. Revline's signed-in /connect page shows the consent; approving posts
 * the handle back with Convex's signed approval, and Convex creates the connection for the signed-in user. */
const consent = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/oauth/authorize') return page('Not found', 404);
    const oauth = env.OAUTH_PROVIDER;
    if (request.method === 'GET') {
      let authRequest;
      try { authRequest = await oauth.parseAuthRequest(request); } catch (error) { return authorizationFailure(error); }
      const details = await oauth.describeConsent(authRequest);
      const transaction = await oauth.beginConsent(authRequest);
      const target = new URL('/connect', env.APP_ORIGIN);
      target.searchParams.set('handle', transaction.handle);
      target.searchParams.set('client_name', details.clientName);
      target.searchParams.set('redirect_uri', authRequest.redirectUri);
      transaction.headers.set('Location', target.toString());
      return new Response(null, { status: 302, headers: transaction.headers });
    }
    if (request.method !== 'POST') return page('Method not allowed', 405);
    const form = await request.formData();
    const handle = String(form.get('handle') ?? ''), approval = String(form.get('approval') ?? '');
    try {
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      const client = await oauth.lookupClient(approved.request.clientId);
      let grant: { ownerId: string; grantId: string; grantKey: string } | { error: 'invalid_approval' | 'plan' };
      // The handle is spent by now; a Convex failure gets a clear page rather than a bare error.
      try { grant = await bridge(env, { op: 'createGrant', approval, handle, clientId: approved.request.clientId, clientName: client?.clientName ?? 'MCP client' }); }
      catch (error) { console.error(`[mcp-oauth] ${JSON.stringify({ event: 'create-grant-failed', message: error instanceof Error ? error.message.slice(0, 300) : 'unknown' })}`); return page('Revline could not finish connecting. Start again from the app you are connecting.', 503); }
      if ('error' in grant) return page(grant.error === 'plan' ? 'Connecting AI apps needs an active Revline plan.' : 'This approval expired. Start again from the app you are connecting.', grant.error === 'plan' ? 403 : 400);
      // Each approval is its own connection, as in Convex: approving an app again does not end its other connections.
      const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: grant.ownerId, metadata: { grantId: grant.grantId }, scope: ['revline'], props: { credential: grant.grantKey } satisfies Props, revokeExistingGrants: false });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) { return authorizationFailure(error); }
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: mcpApi as never,
  defaultHandler: consent as never,
  authorizeEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['revline'],
  // Published in the protected resource document and the 401 challenge, as the Convex server's scopes_supported.
  requiredScopes: ['revline'],
  // Code apps register cursor:, vscode: and similar redirects, as the Convex server allowed.
  allowPrivateUseRedirectUris: true,
  // The Convex server's lifetimes: one-hour access tokens, refresh tokens that live 60 days past their last use.
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 60 * DAY,
  refreshTokenIdleTTL: 60 * DAY,
  // A registered app keeps working as long as it is connected; Convex never expired a client in use either.
  clientRegistrationTTL: undefined,
  resourceMetadata: { resource: `${workerEnv.MCP_ORIGIN}/mcp`, resource_name: 'Revline video editor', bearer_methods_supported: ['header'] },
  // Older connections' Convex tokens: passed through as is and checked by Convex on every request.
  // A grant key is never a bearer token: it only ever comes from this provider's own encrypted props.
  resolveExternalToken: async ({ token }) => token.startsWith(LEGACY_TOKEN) && !token.startsWith(GRANT_KEY) ? { props: { credential: token } satisfies Props, audience: `${workerEnv.MCP_ORIGIN}/mcp` } : null,
  // Revoking a connection in Revline's settings revokes its grant in Convex; its next refresh then ends it here too.
  tokenExchangeCallback: async ({ props, env }) => {
    const credential = (props as Partial<Props> | undefined)?.credential;
    if (!credential) return;
    const reply = await bridge<{ ok: boolean }>(env, { op: 'touchGrant', grantKey: credential });
    if (!reply.ok) throw new OAuthError('invalid_grant', { description: 'This Revline connection was revoked. Connect again.' });
  },
  onError: ({ code, internal }) => { console.warn(`[mcp-oauth] ${JSON.stringify({ code, category: internal?.category, reason: internal?.reason })}`); },
});

function formValues(text: string, contentType: string | null): Record<string, string> {
  if (contentType?.includes('application/json')) { try { const value = JSON.parse(text); return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) as Record<string, string> : {}; } catch { return {}; } }
  const values: Record<string, string> = {};
  new URLSearchParams(text).forEach((value, key) => { values[key] = value; });
  return values;
}

// Discovery addresses the Convex server also answered, kept so clients that probe them still find the provider's documents.
const DISCOVERY_ALIASES: Record<string, string> = {
  '/.well-known/oauth-protected-resource': '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/mcp': '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration': '/.well-known/oauth-authorization-server',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    // uploadMedia's scripts, served under Revline's own domain instead of the deployment's *.convex.site address.
    if (path === '/mcp/upload' || path === '/mcp/upload/model') return request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: cors }) : forwardToConvex(env, request, path);
    if (path === '/oauth/authorize' && request.method === 'GET' && url.searchParams.get('client_id')?.startsWith(LEGACY_CLIENT)) return forwardToConvex(env, request, path);
    if ((path === '/oauth/token' || path === '/oauth/revoke') && request.method === 'POST') {
      const text = await request.text(), form = formValues(text, request.headers.get('Content-Type'));
      const legacy = path === '/oauth/token' ? form.client_id?.startsWith(LEGACY_CLIENT) || form.refresh_token?.startsWith(LEGACY_TOKEN) : form.token?.startsWith(LEGACY_TOKEN);
      if (legacy) return forwardToConvex(env, request, path, text);
      // The provider serves token revocation (RFC 7009) on its token endpoint.
      return provider.fetch(new Request(new URL(`/oauth/token${url.search}`, url), { method: 'POST', headers: request.headers, body: text }), env, ctx);
    }
    if (path === '/oauth/register' && request.method === 'POST') {
      const { success } = await env.REGISTER_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
      if (!success) return json({ error: 'slow_down', error_description: 'Too many registrations. Try again in a minute.' }, 429, { 'Retry-After': '60' });
    }
    const alias = DISCOVERY_ALIASES[path];
    if (alias && (request.method === 'GET' || request.method === 'HEAD')) return provider.fetch(new Request(new URL(alias, url), request), env, ctx);
    return provider.fetch(request, env, ctx);
  },
};
