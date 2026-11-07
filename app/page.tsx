import { LandingNav } from '@/components/landing/nav';
import { LandingHero } from '@/components/landing/hero';
import { LandingFeatures } from '@/components/landing/features';
import { LandingMotionDesign } from '@/components/landing/motion-design';
import { LandingClippers } from '@/components/landing/clippers';
import { LandingMcp } from '@/components/landing/mcp';
import { LandingPricing } from '@/components/landing/pricing';
import { LandingFaq } from '@/components/landing/faq';
import { LandingFinalCta } from '@/components/landing/final-cta';
import { LandingFooter } from '@/components/landing/footer';
import { EDITOR_PLAN, MCP_PLAN } from '@/lib/billing/plan';
import type { Metadata } from 'next';
import './landing.css';

export const metadata: Metadata = { alternates: { canonical: '/' } };

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization', '@id': 'https://tryrevline.com/#organization',
      name: 'Revline', url: 'https://tryrevline.com', logo: 'https://tryrevline.com/brand/revline-square-1024.png',
    },
    {
      '@type': ['SoftwareApplication', 'Product'], '@id': 'https://tryrevline.com/#application',
      name: 'Revline', url: 'https://tryrevline.com', applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web', image: 'https://tryrevline.com/og-revline-v3.png',
      description: 'An AI video editor for prompt-based cuts, captions, vertical clips, motion design and reference video recreation, with MCP access for AI agents.',
      brand: { '@id': 'https://tryrevline.com/#organization' },
      offers: [EDITOR_PLAN, MCP_PLAN].map(plan => ({
        '@type': 'Offer', name: plan === EDITOR_PLAN ? 'Revline Pro' : plan.name, url: 'https://tryrevline.com/pricing', price: plan.monthlyPrice,
        priceCurrency: plan.currency,
        priceSpecification: { '@type': 'UnitPriceSpecification', price: plan.monthlyPrice, priceCurrency: plan.currency, unitText: 'month' },
        description: `${plan.trialDays}-day trial, then $${plan.monthlyPrice} USD per month.`,
      })),
    },
  ],
};

export default function Home() {
  return <main className="landing">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
    <LandingNav />
    <LandingHero />
    <LandingClippers />
    <LandingMotionDesign />
    <LandingFeatures />
    <LandingMcp />
    <LandingPricing />
    <LandingFaq />
    <LandingFinalCta />
    <LandingFooter />
  </main>;
}
