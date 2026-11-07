import { runnerSignature } from '../../convex/lib/runner_auth';

export type BridgeEnv = { CONVEX_SITE_URL: string; MCP_BRIDGE_SECRET: string; MCP_ORIGIN: string };

/** The Convex half of one authenticated MCP request (convex/mcpBridgeHttp.ts). */
export type Auth = { ownerId: string; grantId: string; clientName: string; agentName: string; closed: boolean };
export type AuthError = { error: 'invalid_token' | 'plan' | 'rate_limited' };
export type ToolOutcome = { text: string; images?: { data: string; mimeType: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const base = (env: BridgeEnv) => env.CONVEX_SITE_URL.replace(/\/+$/, '');

/** One signed call to Convex's /mcp-bridge. Convex authenticates the credential each call carries itself. */
export async function bridge<T>(env: BridgeEnv, call: Record<string, unknown>): Promise<T> {
  const url = `${base(env)}/mcp-bridge`, body = JSON.stringify(call);
  for (let attempt = 1; ; attempt++) {
    // Signed per attempt: a retry is a new request, not a replay.
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...await runnerSignature(env.MCP_BRIDGE_SECRET, 'POST', url, body) }, body });
    // Only Convex's own marked refusal means the call never ran; any other 503 may come after a write.
    if (response.status === 503 && response.headers.get('x-revline-bridge') === 'not-run' && attempt < 4) { await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 400 * attempt)); continue; }
    if (!response.ok) throw new Error(`Convex answered ${response.status} on ${String(call.op)}: ${(await response.text()).slice(0, 300)}`);
    return await response.json() as T;
  }
}

/** Requests that still belong to Convex's own handlers (convex/mcpHttp.ts, mcpUploads.ts): passed through unchanged
 * apart from the hop headers, exactly as the website's proxy.ts does. */
export async function forwardToConvex(env: BridgeEnv, request: Request, path: string, body?: BodyInit | null) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of ['host', 'cookie', 'content-length']) headers.delete(name);
  // Convex advertises this origin (convex/lib/mcp_origin.ts) only when it matches its MCP_PUBLIC_ORIGIN.
  headers.set('x-revline-mcp-origin', env.MCP_ORIGIN);
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const response = await fetch(`${base(env)}${path}${url.search}`, { method: request.method, headers, redirect: 'manual', ...(hasBody ? { body: body === undefined ? request.body : body } : {}) });
  const out = new Headers(response.headers);
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
