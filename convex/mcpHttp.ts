import type { HttpRouter } from 'convex/server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, InitializeRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { httpAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { MCP_INSTRUCTIONS } from '../lib/mcp/instructions';
import { requestMcpOrigin } from './lib/mcp_origin';
import { MCP_REFERENCE_COMPARISON_BUDGET_MS } from '../lib/ai/reference-comparison';
import { listMcpResources, readMcpResource } from '../lib/mcp/resources';

// Streamable HTTP MCP server (official MCP SDK, stateless JSON responses) plus
// the OAuth 2.1 authorization server MCP clients discover from it.
const resourceMetadataUrl = (site: string) => `${site}/.well-known/oauth-protected-resource/mcp`;
const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });



const oauthMetadata = (site: string) => ({
  issuer: site, authorization_endpoint: `${site}/oauth/authorize`, token_endpoint: `${site}/oauth/token`, registration_endpoint: `${site}/oauth/register`, revocation_endpoint: `${site}/oauth/revoke`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: ['revline'],
});
const resourceMetadata = (site: string) => ({ resource: `${site}/mcp`, authorization_servers: [site], bearer_methods_supported: ['header'], scopes_supported: ['revline'], resource_name: 'Revline video editor' });

let toolCatalog: Promise<Tool[]> | undefined;
const withCors = (response: Response) => { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(cors)) headers.set(key, value); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); };

/** The official MCP SDK speaks the protocol; Revline supplies auth, the tool list and tool calls. */
function revlineServer(ctx: ActionCtx, ownerId: string, agentName: string, comparisonDeadline: number,connectionId?:string,agentClientId?:Id<'mcpConnections'>) {
  const server = new Server({ name: 'revline', title: 'Revline', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListResourcesRequestSchema, async () => listMcpResources());
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readMcpResource(request.params.uri));
  // One stable catalog for the whole session: clients that never re-fetch tools/list (Codex ignores list_changed) still
  // hold every tool. Lane, capability, owner and task access are enforced on each call instead.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    toolCatalog ??= ctx.runAction(internal.mcpActions.listTools,{}).then(tools=>tools as Tool[]).catch(error=>{toolCatalog=undefined;throw error;});
    return {tools:await toolCatalog};
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await ctx.runAction(internal.mcpActions.callTool, { ownerId, agentName, ...(connectionId ? {connectionId} : {}), ...(agentClientId ? {agentClientId} : {}), name: request.params.name, arguments: request.params.arguments ?? {}, ...(request.params.name === 'compareReference' ? { comparisonDeadline } : {}) });
    return { content: [{ type: 'text' as const, text: outcome.text }, ...(outcome.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))], ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}), isError: outcome.isError };
  });
  return server;
}

const mcpHandler = httpAction(async (ctx, request) => {
  const comparisonDeadline = Date.now() + MCP_REFERENCE_COMPARISON_BUDGET_MS;
  let body: unknown;
  try { body = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  // MCP 2025-06-18 removed JSON-RPC batching; one message per request keeps rate limits exact.
  if (Array.isArray(body)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC message per request.' } }, 400);
  const method = body && typeof body === 'object' ? (body as { method?: unknown }).method : undefined;
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  const challenge = (error?: string) => `Bearer resource_metadata="${resourceMetadataUrl(requestMcpOrigin(request))}"${error ? `, error="${error}"` : ''}`;
  if (!token) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Revline to use this connector.' } }, 401, { 'WWW-Authenticate': challenge() });
  const auth = await ctx.runMutation(internal.mcpAuth.authenticate, { token, calls: method === 'tools/call' ? 1 : 0 });
  if ('error' in auth) {
    if (auth.error === 'invalid_token') return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This Revline connection expired or was revoked. Connect again.' } }, 401, { 'WWW-Authenticate': challenge('invalid_token') });
    if (auth.error === 'rate_limited') return json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Too many tool calls. Wait a minute and retry.' } }, 429, { 'Retry-After': '60' });
    return json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'The Revline MCP connector is part of the Ultra plan.' } }, 403);
  }
  // Transports are request-local; the conversation ID survives in Convex, scoped
  // to the grant. Never use a shared grant as the conversation identity.
  const sessionId = method === 'initialize' ? crypto.randomUUID() : request.headers.get('Mcp-Session-Id');
  if (sessionId && !/^[\x21-\x7e]{1,256}$/.test(sessionId)) return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Mcp-Session-Id.'}},400);
  const connectionId = sessionId ? `${auth.grantId}:${sessionId}` : undefined;
  if (connectionId && method === 'initialize') {
    const initialized=InitializeRequestSchema.safeParse(body);
    if(initialized.success){
      const {name,title,version}=initialized.data.params.clientInfo;
      await ctx.runMutation(internal.mcpConnections.initialize,{ownerId:auth.ownerId,connectionId,clientInfo:{name,version,...(title?{title}:{})},fallbackName:auth.clientName});
    }
  }
  const identity=connectionId?await ctx.runQuery(internal.mcpConnections.identity,{ownerId:auth.ownerId,connectionId}):null;
  if(identity?.closed)return json({jsonrpc:'2.0',id:null,error:{code:-32000,message:'This MCP session ended. Initialize a new session.'}},404);
  const server = revlineServer(ctx, auth.ownerId, identity?.agentName??auth.clientName, comparisonDeadline,connectionId,identity?.clientId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
  try {
    await server.connect(transport);
    const response=await transport.handleRequest(request,{parsedBody:body});
    if (sessionId && method === 'initialize' && response.ok) response.headers.set('Mcp-Session-Id',sessionId);
    if(!response.body){await server.close();return withCors(response);}
    const reader=response.body.getReader();
    const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const {done,value}=await reader.read();if(done){controller.close();await server.close();}else controller.enqueue(value);}catch(error){controller.error(error);await server.close();}},async cancel(){await reader.cancel();await server.close();}});
    return withCors(new Response(stream,{status:response.status,headers:response.headers}));
  } catch(error){await server.close();throw error;}
});

const mcpCloseHandler = httpAction(async (ctx, request) => {
  const token=/^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization')??'')?.[1];
  const auth=token?await ctx.runMutation(internal.mcpAuth.authenticate,{token,calls:0}):null;
  if(!auth||'error' in auth)return json({error:'Sign in to Revline to close this MCP session.'},auth&&auth.error==='plan'?403:401);
  const sessionId=request.headers.get('Mcp-Session-Id');
  if(sessionId)await ctx.runMutation(internal.mcpConnections.close,{ownerId:auth.ownerId,connectionId:`${auth.grantId}:${sessionId}`});
  return new Response(null,{status:204,headers:cors});
});

function formValues(text: string, contentType: string | null): Record<string, string> {
  if (contentType?.includes('application/json')) { try { const value = JSON.parse(text); return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) as Record<string, string> : {}; } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

export function registerMcpRoutes(http: HttpRouter) {
  const options = httpAction(async () => new Response(null, { status: 204, headers: cors }));
  // No standalone event stream; task records do not depend on a live transport.
  const notStreaming = httpAction(async () => new Response(null, { status: 405, headers: { ...cors, Allow: 'POST' } }));
  http.route({ path: '/mcp', method: 'POST', handler: mcpHandler });
  http.route({ path: '/mcp', method: 'GET', handler: notStreaming });
  http.route({ path: '/mcp', method: 'DELETE', handler: mcpCloseHandler });

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    http.route({ path, method: 'GET', handler: httpAction(async (_ctx, request) => json(resourceMetadata(requestMcpOrigin(request)))) });
    http.route({ path, method: 'OPTIONS', handler: options });
  }
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration']) {
    http.route({ path, method: 'GET', handler: httpAction(async (_ctx, request) => json(oauthMetadata(requestMcpOrigin(request)))) });
    http.route({ path, method: 'OPTIONS', handler: options });
  }
  for (const path of ['/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke']) http.route({ path, method: 'OPTIONS', handler: options });

  http.route({ path: '/oauth/register', method: 'POST', handler: httpAction(async (ctx, request) => {
    let metadata: Record<string, unknown>;
    const text = await request.text();
    if (text.length > 20_000) return json({ error: 'invalid_client_metadata', error_description: 'Client metadata is too large.' }, 400);
    try { metadata = JSON.parse(text); } catch { return json({ error: 'invalid_client_metadata', error_description: 'Send client metadata as JSON.' }, 400); }
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
    // Convex's ingress supplies this header. Caller-provided forwarding and
    // origin headers must never choose the registration quota bucket.
    const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const client = await ctx.runMutation(internal.mcpAuth.registerClient, { clientName: typeof metadata.client_name === 'string' ? metadata.client_name : 'MCP client', redirectUris, source });
    if ('error' in client) return client.error === 'rate_limited' ? json({ error: 'slow_down', error_description: 'Too many registrations. Try again in a minute.' }, 429, { 'Retry-After': '60' }) : json({ error: 'invalid_redirect_uri', error_description: 'Use https, loopback http or an app scheme redirect, up to 10.' }, 400);
    return json({ client_id: client.clientId, client_id_issued_at: Math.floor(client.createdAt / 1000), client_name: typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 100) : 'MCP client', redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201);
  }) });

  http.route({ path: '/oauth/authorize', method: 'GET', handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    const clientId = params.get('client_id') ?? '', redirectUri = params.get('redirect_uri') ?? '';
    // Never redirect to an address the client did not register.
    if (!clientId || !redirectUri || !await ctx.runQuery(internal.mcpAuth.checkAuthorizeRequest, { clientId, redirectUri })) return new Response('Unknown app or redirect address. Remove and add the Revline connector again.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
    const back = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error); target.searchParams.set('error_description', description);
      if (params.get('state') !== null) target.searchParams.set('state', params.get('state')!);
      return new Response(null, { status: 302, headers: { Location: target.toString() } });
    };
    if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'Only the authorization code flow is supported.');
    if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) return back('invalid_request', 'PKCE with S256 is required.');
    const consent = new URL(`${process.env.APP_ORIGIN}/connect`);
    for (const key of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource']) { const value = params.get(key); if (value !== null) consent.searchParams.set(key, value); }
    return new Response(null, { status: 302, headers: { Location: consent.toString() } });
  }) });

  http.route({ path: '/oauth/token', method: 'POST', handler: httpAction(async (ctx, request) => {
    const form = formValues(await request.text(), request.headers.get('Content-Type'));
    const clientId = form.client_id ?? '';
    if (!clientId) return json({ error: 'invalid_client', error_description: 'client_id is required.' }, 401);
    const outcome = form.grant_type === 'authorization_code'
      ? await ctx.runMutation(internal.mcpAuth.exchangeCode, { code: form.code ?? '', clientId, redirectUri: form.redirect_uri ?? '', codeVerifier: form.code_verifier ?? '', ...(form.resource ? { resource: form.resource } : {}) })
      : form.grant_type === 'refresh_token'
        ? await ctx.runMutation(internal.mcpAuth.refreshTokens, { refreshToken: form.refresh_token ?? '', clientId })
        : { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' };
    return json(outcome, 'error' in outcome ? 400 : 200, { Pragma: 'no-cache' });
  }) });

  http.route({ path: '/oauth/revoke', method: 'POST', handler: httpAction(async (ctx, request) => {
    const form = formValues(await request.text(), request.headers.get('Content-Type'));
    if (form.token) await ctx.runMutation(internal.mcpAuth.revokeToken, { token: form.token });
    return new Response(null, { status: 200, headers: cors });
  }) });
}
