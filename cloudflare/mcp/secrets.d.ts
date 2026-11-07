// Secrets set with `wrangler secret put --config cloudflare/mcp/wrangler(.production).jsonc` (never in the config).
declare namespace Cloudflare {
  interface Env {
    /** Shared with the Convex deployment this Worker serves (MCP_BRIDGE_SECRET there); signs every bridge call. */
    MCP_BRIDGE_SECRET: string;
  }
}
