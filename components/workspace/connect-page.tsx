'use client';
import { userError } from '@/lib/user-error';

import { useEffect, useState } from 'react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useUser } from '@clerk/nextjs';
import { Check, CircleCheck, LoaderCircle } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import { Brand } from './brand';
import { PrimaryButton } from './primary-button';
import './workspace-pages.css';
import './connect-page.css';
import { Button } from '@/components/ui/button';

/** A Convex OAuth request (older connections), or a consent `handle` from the Cloudflare MCP server (cloudflare/mcp). */
export type ConnectRequest = { clientId?: string; redirectUri?: string; codeChallenge?: string; codeChallengeMethod?: string; state?: string; resource?: string; handle?: string; clientName?: string };

/** The MCP server that started a handle's consent; its cookie is bound to that origin. Same origin in production. */
const mcpOrigin = () => process.env.NEXT_PUBLIC_MCP_ORIGIN?.replace(/\/$/, '') || window.location.origin;

/** Hands the decision back to the MCP server as a top-level form post, so its consent cookie comes along. */
function postConsent(fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST'; form.action = `${mcpOrigin()}/oauth/authorize`;
  for (const [name, value] of Object.entries(fields)) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input); }
  document.body.appendChild(form); form.submit(); form.remove();
}

/** Apps on this computer (Claude Code, Codex) take the code on a localhost callback page of their own. */
const loopback = (uri: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri).hostname);

const permissions = ['See your projects, media and transcripts', 'Edit timelines with Revline’s editing tools; every edit is saved and undoable', 'Import video links and start exports'];

/** OAuth consent for an MCP client such as Claude or ChatGPT. */
export function ConnectPage({ request }: { request: ConnectRequest }) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useUser();
  const cloudflare = !!request.handle;
  const complete = cloudflare ? !!request.redirectUri : !!request.clientId && !!request.redirectUri && !!request.codeChallenge;
  const convexDetails = useQuery(api.mcpAuth.authorizationRequest, isAuthenticated && complete && !cloudflare ? { clientId: request.clientId!, redirectUri: request.redirectUri! } : 'skip');
  const access = useQuery(api.mcpAuth.consentAccess, isAuthenticated && complete && cloudflare ? { redirectUri: request.redirectUri! } : 'skip');
  // The client's name comes from its own registration either way; the MCP server holds the request itself.
  const details = cloudflare ? access && (access.ok ? { ...access, clientName: request.clientName?.slice(0, 100) || 'MCP client' } : access) : convexDetails;
  const approve = useMutation(api.mcpAuth.approve);
  const approveConsent = useMutation(api.mcpAuth.approveConsent);
  const [busy, setBusy] = useState<'approve' | 'cancel' | ''>('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  // Backstop for the frame-ancestors header: approving from inside another page is refused.
  const [framed, setFramed] = useState(false);
  useEffect(() => { setFramed(window.top !== window.self); }, []);

  async function allow() {
    if (window.top !== window.self) return;
    setBusy('approve'); setError('');
    // A local app's callback opens in a small window that closes itself, so this page can show the result.
    // Opened before the await so the click still counts and the popup isn't blocked.
    // A Cloudflare consent goes back as a top-level post, so the MCP server's own page reports any failure.
    const local = !cloudflare && loopback(request.redirectUri!);
    const handoff = local ? window.open('about:blank', 'revline-connect', 'popup,width=420,height=320') : null;
    try {
      if (cloudflare) {
        const { approval } = await approveConsent({ handle: request.handle! });
        postConsent({ handle: request.handle!, decision: 'approve', approval });
        return;
      }
      const { redirectTo } = await approve({ clientId: request.clientId!, redirectUri: request.redirectUri!, codeChallenge: request.codeChallenge!, codeChallengeMethod: request.codeChallengeMethod ?? '', ...(request.state !== undefined ? { state: request.state } : {}), ...(request.resource !== undefined ? { resource: request.resource } : {}) });
      setConnected(true);
      if (handoff) { handoff.location.href = redirectTo; window.setTimeout(() => handoff.close(), 2500); }
      else window.setTimeout(() => window.location.assign(redirectTo), 1600);
    } catch (cause) { handoff?.close(); setError(userError(cause, 'Could not connect. Please try again.')); setBusy(''); }
  }
  // Only a redirect address the server confirmed is registered for this app.
  function cancel() {
    setBusy('cancel');
    if (cloudflare) { postConsent({ handle: request.handle!, decision: 'deny' }); return; }
    const target = new URL(request.redirectUri!);
    target.searchParams.set('error', 'access_denied');
    if (request.state !== undefined) target.searchParams.set('state', request.state);
    window.location.assign(target.toString());
  }

  let body;
  if (framed) body = <p className="connect-message">Open this page directly to connect an app.</p>;
  else if (!complete) body = <p className="connect-message">This connection link is incomplete. Start again from the app you are connecting.</p>;
  else if (details === undefined) body = <div className="connect-message" role="status"><LoaderCircle size={18} className="animate-spin" /></div>;
  else if (!details.ok) body = <p className="connect-message">{details.message}</p>;
  else if (connected) body = <div className="connect-done" role="status">
    <CircleCheck size={28} strokeWidth={1.5} className="connect-done-icon" aria-hidden="true" />
    <h1>Connected</h1>
    <p className="connect-lead">You can close this window.</p>
  </div>;
  else body = <>
    <h1>Connect {details.clientName} to Revline</h1>
    <p className="connect-lead">An app calling itself “{details.clientName}” is asking to use your Revline account{user?.primaryEmailAddress ? <> ({user.primaryEmailAddress.emailAddress})</> : null}. Access will be sent to <strong>{details.redirectHost}</strong>.</p>
    {!details.trusted && <p className="connect-warning" role="note">This isn’t a Claude, ChatGPT or local address. Only allow it if you started this connection yourself and recognize {details.redirectHost}.</p>}
    {details.allowed ? <ul className="connect-permissions">{permissions.map(item => <li key={item}><Check size={14} />{item}</li>)}</ul>
      : <p className="connect-message">Connecting AI apps needs an active Revline plan.</p>}
    <p className="connect-note">Revoke access any time in your profile.</p>
    {error && <p className="workspace-inline-error" role="alert">{error}</p>}
    <div className="connect-actions">
      <Button variant="outline" size="md" type="button" disabled={!!busy} onClick={cancel}>Cancel</Button>
      {details.allowed && <PrimaryButton size="compact" disabled={!!busy} onClick={() => void allow()}>{busy === 'approve' && <LoaderCircle size={13} className="animate-spin" />}Allow access</PrimaryButton>}
    </div>
  </>;

  return <div className="workspace-page connect-page"><main className="connect-card"><Brand className="connect-brand" />{body}</main></div>;
}
