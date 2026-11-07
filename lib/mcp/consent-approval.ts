// A signed-in user's approval of one OAuth consent handle on the Cloudflare MCP server (cloudflare/mcp). Convex signs
// it for the consent page under MCP_BRIDGE_SECRET; the page posts it to the Worker, which hands it back to Convex to
// create the connection. Convex checks it again there, so the Worker can never choose whose account is connected.
export const CONSENT_APPROVAL_TTL_MS = 5 * 60_000;
export type ConsentApproval = { ownerId: string; handle: string; nonce: string; expires: number };

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const key = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
// Domain-separated from the bridge's request signatures, which share the secret.
const signed = (payload: string) => encoder.encode(`revline-mcp-consent\n${payload}`);

export async function signConsentApproval(secret: string, approval: ConsentApproval) {
  const payload = base64url(encoder.encode(JSON.stringify(approval)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, 'sign'), signed(payload)));
  return `${payload}.${base64url(signature)}`;
}

/** The approval if it was signed with this secret and has not expired, else null. */
export async function verifyConsentApproval(secret: string | undefined, token: string): Promise<ConsentApproval | null> {
  const [payload, signature, extra] = token.split('.');
  if (!secret || !payload || !signature || extra !== undefined || token.length > 2000) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await key(secret, 'verify'), fromBase64url(signature), signed(payload))) return null;
    const approval = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as ConsentApproval;
    if (typeof approval.ownerId !== 'string' || typeof approval.handle !== 'string' || typeof approval.nonce !== 'string' || typeof approval.expires !== 'number' || approval.expires < Date.now()) return null;
    return approval;
  } catch { return null; }
}
