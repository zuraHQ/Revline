import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const clerk = clerkMiddleware();

// Fallback path for the MCP server and its OAuth endpoints: the revline-mcp Worker (cloudflare/mcp) serves them on
// tryrevline.com through routes, which take precedence over this Worker's custom domain. Without those routes
// (before cutover, or after a rollback) tryrevline.com/mcp passes them through to Convex so clients only ever see
// Revline's own domain (see convex/lib/mcp_origin.ts).
const MCP_PATHS = /^\/(?:mcp(?:\/upload(?:\/model)?)?|oauth\/(?:authorize|token|register|revoke)|\.well-known\/(?:oauth-protected-resource|oauth-authorization-server)(?:\/mcp)?|\.well-known\/openid-configuration)$/;

async function forwardToMcp(request: NextRequest) {
  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, process.env.NEXT_PUBLIC_CONVEX_SITE_URL);
  const headers = new Headers(request.headers);
  for (const name of ['host', 'cookie', 'content-length']) headers.delete(name);
  headers.set('x-revline-mcp-origin', request.nextUrl.origin);
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  const response = await fetch(target, { method: request.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: request.body, duplex: 'half' as const }) });
  // fetch already decoded the body.
  const out = new Headers(response.headers);
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const url = request.nextUrl;
  const hostname = request.headers.get('host')?.split(':')[0] ?? url.hostname;
  const forwardedProtocol = request.headers.get('x-forwarded-proto');
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https' ? `${forwardedProtocol}:` : url.protocol;
  const publicPage = ['/', '/pricing', '/podcast-clips', '/ai-video-captions', '/reference-video-recreation', '/robots.txt', '/sitemap.xml'].includes(url.pathname) || url.pathname === '/blog' || url.pathname.startsWith('/blog/');
  if (['tryrevline.com', 'editor.tryrevline.com'].includes(hostname) && (protocol === 'http:' || (hostname === 'editor.tryrevline.com' && publicPage))) {
    const destination = url.clone();
    destination.protocol = 'https:';
    destination.hostname = publicPage ? 'tryrevline.com' : hostname;
    destination.port = '';
    return NextResponse.redirect(destination, 308);
  }
  // This public renderer shell authenticates project reads with the native Convex JWT.
  // A web-session handshake would navigate WKWebView outside its pinned player URL.
  if (/^\/mobile\/player\/[^/]+\/?$/.test(request.nextUrl.pathname)) return NextResponse.next();
  return MCP_PATHS.test(request.nextUrl.pathname) ? forwardToMcp(request) : clerk(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
