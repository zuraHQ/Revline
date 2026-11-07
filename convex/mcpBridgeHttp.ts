import type { HttpRouter } from 'convex/server';
import { httpAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { verifyRunnerRequest } from './lib/runner_auth';
import { clientInfoValidator } from './mcpConnections';
import type { Infer } from 'convex/values';

// The Cloudflare MCP server (cloudflare/mcp) speaks the protocol and runs the OAuth provider; Convex keeps the data,
// the tools and every access decision. Each call is signed with MCP_BRIDGE_SECRET under a single-use nonce
// (lib/runner_auth.ts). Calls that act for a user carry that user's credential, which Convex authenticates itself:
// the Worker never names an owner. Grant keys (kind "grant") are accepted only here.
type Credential = { credential: string };
type Call =
  | ({ op: 'authenticate'; calls: number; sessionId?: string } & Credential)
  | ({ op: 'initialize'; sessionId: string; clientInfo: Infer<typeof clientInfoValidator> } & Credential)
  | ({ op: 'close'; sessionId: string } & Credential)
  | { op: 'listTools' }
  | ({ op: 'callTool'; sessionId?: string; name: string; arguments: unknown; comparisonDeadline?: number } & Credential)
  | { op: 'createGrant'; approval: string; handle: string; clientId: string; clientName: string }
  | { op: 'touchGrant'; grantKey: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
// Same session-id rule as convex/mcpHttp.ts.
const validSession = (value: unknown) => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);

async function authenticate(ctx: ActionCtx, credential: string, calls: number) {
  return ctx.runMutation(internal.mcpAuth.authenticate, { token: credential, calls, bridge: true });
}

/** The connection one MCP session belongs to, scoped to its grant like the Convex server does. */
async function connection(ctx: ActionCtx, ownerId: string, grantId: string, sessionId: string | undefined) {
  const connectionId = sessionId ? `${grantId}:${sessionId}` : undefined;
  const identity = connectionId ? await ctx.runQuery(internal.mcpConnections.identity, { ownerId, connectionId }) : null;
  return { connectionId, identity };
}

async function handle(ctx: ActionCtx, call: Call): Promise<Response> {
  switch (call.op) {
    case 'authenticate': {
      if (!text(call.credential, 500) || !Number.isInteger(call.calls) || call.calls < 0 || call.calls > 1 || (call.sessionId !== undefined && !validSession(call.sessionId))) return json({ error: 'bad_request' }, 400);
      const auth = await authenticate(ctx, call.credential, call.calls);
      if ('error' in auth) return json(auth);
      const { identity } = await connection(ctx, auth.ownerId, auth.grantId, call.sessionId);
      return json({ ownerId: auth.ownerId, grantId: auth.grantId, clientName: auth.clientName, agentName: identity?.agentName ?? auth.clientName, closed: identity?.closed ?? false });
    }
    case 'initialize': {
      if (!text(call.credential, 500) || !validSession(call.sessionId)) return json({ error: 'bad_request' }, 400);
      const auth = await authenticate(ctx, call.credential, 0);
      if ('error' in auth) return json(auth);
      const clientInfo = call.clientInfo;
      if (!clientInfo || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string' || (clientInfo.title !== undefined && typeof clientInfo.title !== 'string')) return json({ error: 'bad_request' }, 400);
      await ctx.runMutation(internal.mcpConnections.initialize, { ownerId: auth.ownerId, connectionId: `${auth.grantId}:${call.sessionId}`, clientInfo: { name: clientInfo.name, version: clientInfo.version, ...(clientInfo.title ? { title: clientInfo.title } : {}) }, fallbackName: auth.clientName });
      return json({ ok: true });
    }
    case 'close': {
      if (!text(call.credential, 500) || !validSession(call.sessionId)) return json({ error: 'bad_request' }, 400);
      const auth = await authenticate(ctx, call.credential, 0);
      if ('error' in auth) return json(auth);
      await ctx.runMutation(internal.mcpConnections.close, { ownerId: auth.ownerId, connectionId: `${auth.grantId}:${call.sessionId}` });
      return json({ ok: true });
    }
    case 'listTools':
      return json({ tools: await ctx.runAction(internal.mcpActions.listTools, {}) });
    case 'callTool': {
      if (!text(call.credential, 500) || !text(call.name, 200) || (call.sessionId !== undefined && !validSession(call.sessionId))) return json({ error: 'bad_request' }, 400);
      // Counted against the rate limit when the Worker authenticated this request; here it only proves who is calling.
      const auth = await authenticate(ctx, call.credential, 0);
      if ('error' in auth) return json(auth);
      const { connectionId, identity } = await connection(ctx, auth.ownerId, auth.grantId, call.sessionId);
      if (identity?.closed) return json({ error: 'session_closed' });
      const outcome = await ctx.runAction(internal.mcpActions.callTool, {
        ownerId: auth.ownerId, agentName: identity?.agentName ?? auth.clientName,
        ...(connectionId ? { connectionId } : {}), ...(identity ? { agentClientId: identity.clientId } : {}),
        name: call.name, arguments: call.arguments ?? {},
        ...(call.name === 'compareReference' && typeof call.comparisonDeadline === 'number' ? { comparisonDeadline: call.comparisonDeadline } : {}),
      });
      return json({ outcome });
    }
    case 'createGrant':
      if (!text(call.approval, 2000) || !text(call.handle, 500) || !text(call.clientId, 500) || typeof call.clientName !== 'string') return json({ error: 'bad_request' }, 400);
      return json(await ctx.runMutation(internal.mcpAuth.createGrant, { approval: call.approval, handle: call.handle, clientId: call.clientId, clientName: call.clientName.slice(0, 200) }));
    case 'touchGrant':
      if (!text(call.grantKey, 500)) return json({ error: 'bad_request' }, 400);
      return json({ ok: await ctx.runMutation(internal.mcpAuth.touchGrant, { grantKey: call.grantKey }) });
    default:
      return json({ error: 'bad_request' }, 400);
  }
}

/** Refused before running, so the Worker may send it again, even a write. Marked, so no other 503 is mistaken for it. */
const notRun = () => new Response('Try again', { status: 503, headers: { 'x-revline-bridge': 'not-run' } });

export function registerMcpBridgeRoutes(http: HttpRouter) {
  http.route({ path: '/mcp-bridge', method: 'POST', handler: httpAction(async (ctx, request) => {
    if (Number(request.headers.get('content-length') ?? 0) > 4_000_000) return new Response('Too large', { status: 413 });
    const body = await request.arrayBuffer();
    let nonce: string | null;
    try { nonce = await verifyRunnerRequest(process.env.MCP_BRIDGE_SECRET, request, body); } catch { return notRun(); }
    if (!nonce) return new Response('Unauthorized', { status: 401 });
    let call: Call;
    try { call = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response('Bad request', { status: 400 }); }
    try { if (!await ctx.runMutation(internal.agentRunner.useNonce, { nonce })) return new Response('Unauthorized', { status: 401 }); }
    catch { return notRun(); }
    try { return await handle(ctx, call); }
    catch (error) {
      console.error('[mcp-bridge] call failed', { op: call?.op, message: error instanceof Error ? error.message.slice(0, 300) : 'unknown' });
      return json({ error: 'failed', message: error instanceof Error ? error.message.slice(0, 1000) : 'The call failed.' }, 500);
    }
  }) });
}
