import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertIsolated, isolatedRuntime } from './isolated-common.mjs';

// A worktree-scoped revline-local transport. The global connector remains on main.
const state = assertIsolated();
const settings = await isolatedRuntime();
// REVLINE_MCP_URL points it at another server for the same backend, such as `npm run dev:mcp` (cloudflare/mcp).
const upstream = new StreamableHTTPClientTransport(new URL(process.env.REVLINE_MCP_URL || `https://${state.name}.convex.site/mcp`), { requestInit: { headers: { Authorization: `Bearer ${settings.REVLINE_MCP_TOKEN}` } } });
const server = new Server({ name: 'revline-local', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
let client, ready, closing = false;
server.oninitialized = () => {
  client = new Client(server.getClientVersion() ?? { name: 'revline-local', version: '1.0.0' });
  ready = client.connect(upstream);
  void ready.catch(() => {});
};
async function connected() {
  if (!client || !ready) throw new Error('Initialize the MCP client first.');
  await ready;
  return client;
}
server.setRequestHandler(ListToolsRequestSchema, async () => (await connected()).listTools());
server.setRequestHandler(ListResourcesRequestSchema, async request => (await connected()).listResources(request.params));
server.setRequestHandler(ReadResourceRequestSchema, async request => (await connected()).readResource(request.params));
server.setRequestHandler(CallToolRequestSchema, async request => (await connected()).callTool(request.params, undefined, { timeout: 600_000 }));
async function close() {
  if (closing) return;
  closing = true;
  try { await ready; await upstream.terminateSession(); }
  catch { process.stderr.write('Could not close the isolated MCP session.\n'); process.exitCode = 1; }
  finally { await client?.close(); await server.close(); }
}
server.onclose = () => { void close(); };
process.stdin.on('end', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close(); });
await server.connect(new StdioServerTransport());
