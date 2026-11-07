import { Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EDITOR_PLAN, MCP_FEATURES, MCP_PLAN, ULTRA_FEATURES, ULTRA_OFFERED, ULTRA_PLAN } from '@/lib/billing/plan';
import { LandingStartButton } from './start-button';
import { LandingHeading, LandingSection } from './ui';

// The landing's own Pro list (from the design); billing pages keep PRO_FEATURES.
const PRO_LANDING_FEATURES = ['Edit by prompting inside Revline', 'AI trims and cuts', 'Animated subtitles', 'Text effects', 'Background removal', 'Motion design and masking', `${EDITOR_PLAN.storageGb} GB storage`];

type Plan = { name: string; description: string; price: number; lead?: string; features: readonly string[]; cta: string; note: string; primary: boolean; signedInHref?: string; ultra?: true };
const plans = ([
  { name: MCP_PLAN.name, description: 'For editing from your AI agent.', price: MCP_PLAN.monthlyPrice, features: MCP_FEATURES, cta: 'Start free trial', note: `${MCP_PLAN.trialDays} days free, then $${MCP_PLAN.monthlyPrice}/month`, primary: false },
  { name: 'Revline Pro', description: 'For everyone.', price: EDITOR_PLAN.monthlyPrice, lead: 'Everything in MCP, plus', features: PRO_LANDING_FEATURES, cta: 'Start free trial', note: `${EDITOR_PLAN.trialDays} days free, then $${EDITOR_PLAN.monthlyPrice}/month`, primary: !ULTRA_OFFERED },
  { name: 'Revline Ultra', description: 'For power users.', price: ULTRA_PLAN.monthlyPrice, lead: 'Everything in Pro, plus', features: ULTRA_FEATURES, cta: 'Get Ultra', note: 'Cancel anytime', primary: true, signedInHref: '/profile#billing', ultra: true },
] satisfies Plan[] as Plan[]).filter(plan => ULTRA_OFFERED || !plan.ultra);

export function LandingPricing() {
  return <LandingSection id="pricing" className="landing-pricing" headingId="landing-pricing-heading" data-nav-tone="dark">
    <LandingHeading id="landing-pricing-heading" align="center" title="Cheaper than an editor. Faster too." description={`Try it free for ${EDITOR_PLAN.trialDays} days. Cancel anytime.`} />
    <div className="landing-plans">{plans.map(plan => <Card key={plan.name} className="landing-plan" role="article" aria-label={plan.name}>
      <header>
        <h3>{plan.name}</h3>
        <p>{plan.description}</p>
      </header>
      <div className="landing-price"><strong>${plan.price}</strong><span>/ month</span></div>
      <ul>
        {plan.lead && <li className="landing-plan-lead">{plan.lead}</li>}
        {plan.features.map(feature => <li key={feature}><Check size={16} aria-hidden="true" />{feature}</li>)}
      </ul>
      <footer>
        <LandingStartButton label={plan.cta} variant={plan.primary ? 'primary' : 'secondary'} size="lg" block {...(plan.signedInHref ? { signedInHref: plan.signedInHref } : {})} />
        <small>{plan.note}</small>
      </footer>
    </Card>)}</div>
  </LandingSection>;
}
