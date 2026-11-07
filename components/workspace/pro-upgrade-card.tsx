'use client';
import { useRef, useState } from 'react';
import { useAction } from 'convex/react';
import { Check, LoaderCircle } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import { EDITOR_PLAN, PRO_OVER_MCP } from '@/lib/billing/plan';
import { userError } from '@/lib/user-error';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PrimaryButton } from './primary-button';
import './pro-upgrade-card.css';

/** For Revline MCP members where Pro-only editing by prompting would be: moves the subscription to Pro in place. */
export function ProUpgradeCard({ trialing = false, className }: { trialing?: boolean; className?: string }) {
  const upgrade = useAction(api.billing.upgradeToPro);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await upgrade({}); setDone(true); }
    catch (cause) { setError(userError(cause, 'Could not upgrade to Pro. Please try again.')); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <Card size="sm" className={`pro-upgrade-card${className ? ` ${className}` : ''}`} role="region" aria-labelledby="pro-upgrade-title">
    <CardHeader>
      <CardTitle id="pro-upgrade-title">Editing by prompting is part of Pro</CardTitle>
      <CardDescription>Your Revline MCP plan edits from Claude, ChatGPT, Codex or Cursor. Upgrade to also edit by prompting here.</CardDescription>
    </CardHeader>
    <CardContent className="pro-upgrade-body">
      <ul aria-label="Pro adds">
        {PRO_OVER_MCP.map(feature => <li key={feature}><Check size={14} strokeWidth={1.5} aria-hidden="true" />{feature}</li>)}
      </ul>
      {done ? <p role="status">Upgrading to Pro. This takes a few seconds…</p> : <>
        <PrimaryButton size="compact" disabled={busy} onClick={() => confirm ? void run() : setConfirm(true)}>
          {busy && <LoaderCircle size={14} className="animate-spin" />}
          {confirm ? 'Confirm upgrade' : `Upgrade to Pro · $${EDITOR_PLAN.monthlyPrice}/month`}
        </PrimaryButton>
        {confirm && <small>{trialing ? 'Your free trial continues on Pro.' : 'You\'ll be charged the prorated difference today.'}</small>}
      </>}
      {error && <p className="pro-upgrade-error" role="alert">{error}</p>}
    </CardContent>
  </Card>;
}
