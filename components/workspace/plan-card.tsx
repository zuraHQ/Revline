import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import './plan-card.css';

/** A plan offer in the app (paywall, billing), drawn like the Pro card. `children` is the call to action. */
export function PlanCard({ id, title, description, price, currency, lead, features, children, note }: {
  id: string; title: string; description?: ReactNode; price: number; currency: string; lead?: string;
  features: readonly string[]; children?: ReactNode; note?: ReactNode;
}) {
  return <Card className="plan-card" role="region" aria-labelledby={`${id}-title`}>
    <header>
      <h2 id={`${id}-title`}>{title}</h2>
      {description && <p>{description}</p>}
    </header>
    <div className="plan-card-price"><strong>${price}</strong><span>/ month · {currency}</span></div>
    <ul aria-label={`${title} includes`}>
      {lead && <li className="plan-card-lead">{lead}</li>}
      {features.map(feature => <li key={feature}><Check size={16} strokeWidth={1.5} aria-hidden="true" />{feature}</li>)}
    </ul>
    {(children || note) && <div className="plan-card-action">{children}{note && <small>{note}</small>}</div>}
  </Card>;
}
