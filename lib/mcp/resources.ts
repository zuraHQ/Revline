import { BACKGROUND_PREVIEW_URI, MCP_APP_MIME, mcpAppDocument } from '../editor/background-preview';

// MCP Apps (io.modelcontextprotocol/ui, 2026-01-26): previewBackgrounds names this view in its tool _meta.ui.resourceUri.
// Served the same way by the Convex server (convex/mcpHttp.ts) and the Cloudflare one (cloudflare/mcp).
export const listMcpResources = () => ({ resources: [{ uri: BACKGROUND_PREVIEW_URI, name: 'background_previews', title: 'Background candidates', description: 'Inline picker for previewBackgrounds results.', mimeType: MCP_APP_MIME }] });

export function readMcpResource(uri: string) {
  if (uri !== BACKGROUND_PREVIEW_URI) throw new Error(`Unknown resource ${uri}.`);
  return { contents: [{ uri: BACKGROUND_PREVIEW_URI, mimeType: MCP_APP_MIME, text: mcpAppDocument(), _meta: { ui: { csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] }, prefersBorder: false } } }] };
}
