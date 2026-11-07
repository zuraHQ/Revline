import { v } from 'convex/values';
import { internalQuery } from './_generated/server';

// Settings shown as their value; everything else is reported only as set or missing.
const VALUES = ['APP_ORIGIN', 'MCP_PUBLIC_ORIGIN', 'RENDER_PROVIDER', 'MEDIA_PROCESSOR_BACKEND', 'MEDIA_PROCESSOR_MAX_WORKERS', 'EXPORT_MAX_WORKERS_STANDARD', 'EXPORT_MAX_WORKERS_ULTRA',
  'BILLING_ENABLED', 'STRIPE_PRO_PRICE_ID', 'STRIPE_MCP_PRICE_ID', 'STRIPE_ULTRA_PRICE_ID', 'EDITOR_DEFAULT_MODEL', 'MODEL_SWITCHER_ENABLED', 'EDITOR_MODEL_CHOICE_OPEN',
  'EDITOR_ENFORCE_TOKEN_BUDGET', 'DISCORD_ALERTS_ENABLED'] as const;
const SECRETS = ['RENDER_WORKER_SECRET', 'RENDER_WORKER_SECRET_PREVIOUS', 'MEDIA_WORKER_SECRET_EXPORTS', 'MEDIA_SIGNING_SECRET', 'MEDIA_PROCESSOR_WAKE_URL', 'MEDIA_WORKER_URL',
  'RAILWAY_API_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CLERK_JWT_ISSUER_DOMAIN', 'CLERK_WEBHOOK_SIGNING_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DISCORD_WEBHOOK_URL', 'SENTRY_WEBHOOK_SECRET', 'POSTHOG_WEBHOOK_SECRET'] as const;

/** Admin CLI only (`npm run check:setup`): how this deployment is configured, without secret values. */
export const report = internalQuery({ args: {}, returns: v.any(), handler: async () => {
  const env = process.env, stripe = env.STRIPE_SECRET_KEY ?? '';
  return {
    site: env.CONVEX_SITE_URL ?? '',
    stripeMode: stripe.startsWith('sk_live_') ? 'live' : stripe.startsWith('sk_test_') ? 'test' : stripe ? 'unknown' : 'missing',
    values: Object.fromEntries(VALUES.map(name => [name, env[name] ?? null])),
    secrets: Object.fromEntries(SECRETS.map(name => [name, !!env[name]])),
  };
}});
