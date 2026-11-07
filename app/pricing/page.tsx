import type { Metadata } from 'next';
import { LandingNav } from '@/components/landing/nav';
import { LandingPricing } from '@/components/landing/pricing';
import { LandingFaq } from '@/components/landing/faq';
import { LandingFooter } from '@/components/landing/footer';
import { EDITOR_PLAN, MCP_PLAN } from '@/lib/billing/plan';
import '../landing.css';

export const metadata: Metadata = {
  title: 'Revline pricing',
  description: `Revline MCP is $${MCP_PLAN.monthlyPrice} USD per month and Revline Pro $${EDITOR_PLAN.monthlyPrice}, each after a ${EDITOR_PLAN.trialDays}-day trial. Both include unlimited MCP calls and 1080p exports; Pro adds editing by prompting in Revline.`,
  alternates: { canonical: '/pricing' },
};

export default function PricingPage() {
  return <main className="landing">
    <LandingNav />
    <section className="landing-section landing-hero"><div className="landing-hero-copy"><h1>Revline pricing</h1></div></section>
    <LandingPricing />
    <LandingFaq />
    <LandingFooter />
  </main>;
}
