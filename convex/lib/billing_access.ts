import { ULTRA_OFFERED } from '../../lib/billing/plan';
import { ConvexError } from 'convex/values';
import { components } from '../_generated/api';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';
import { activeAppleEntitlement, hasPaidAppleModelAccess } from './apple_entitlements';
import { isMcpRun } from './run_ids';

export const billingEnabled = () => process.env.BILLING_ENABLED === 'true';
export const billingConfigured = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET && !!process.env.STRIPE_PRO_PRICE_ID && !!process.env.APP_ORIGIN;
export const ultraBillingConfigured = () => ULTRA_OFFERED && billingConfigured() && !!process.env.STRIPE_ULTRA_PRICE_ID;
export const mcpBillingConfigured = () => billingConfigured() && !!process.env.STRIPE_MCP_PRICE_ID;
const isUltraSubscription = (sub: { priceId: string }) => !!process.env.STRIPE_ULTRA_PRICE_ID && sub.priceId === process.env.STRIPE_ULTRA_PRICE_ID;
/** A Revline MCP subscription: every MCP tool and the web editor, but no in-app editor agent. Checkout also tags it
 * metadata.plan 'mcp', so a missing or rotated STRIPE_MCP_PRICE_ID never turns it into Pro; upgrades clear the tag. */
export const isMcpSubscription = (sub: { priceId: string; metadata?: Record<string, unknown> }) => (!!process.env.STRIPE_MCP_PRICE_ID && sub.priceId === process.env.STRIPE_MCP_PRICE_ID) || sub.metadata?.plan === 'mcp';
export const isEditorSubscription = (sub: { priceId: string; metadata?: Record<string, unknown> }) => sub.priceId === process.env.STRIPE_PRO_PRICE_ID || isUltraSubscription(sub) || isMcpSubscription(sub) || sub.metadata?.app === 'revline-editor';
export const hasPaidEditorSubscriptionTerm = (sub: { status: string; currentPeriodEnd: number }) => sub.status === 'active' && sub.currentPeriodEnd > Date.now() / 1000;
export const hasEditorAccess = (sub: { status: string; currentPeriodEnd: number }) => (sub.status === 'active' || sub.status === 'trialing') && sub.currentPeriodEnd > Date.now() / 1000;

export async function editorSubscriptions(ctx: QueryCtx | MutationCtx | ActionCtx, userId: string) {
  return (await ctx.runQuery(components.stripe.public.listSubscriptionsByUserId, { userId })).filter(isEditorSubscription);
}

/** An operator grant that is neither revoked nor expired. */
async function activeComplimentaryEntitlement(ctx: QueryCtx | MutationCtx, ownerId: string) {
  const entitlement = await ctx.db.query('editorEntitlements').withIndex('by_owner', q => q.eq('ownerId', ownerId)).unique();
  return entitlement && entitlement.revokedAt === undefined && (entitlement.expiresAt === undefined || entitlement.expiresAt > Date.now()) ? entitlement : null;
}

export async function hasComplimentaryEditorAccess(ctx: QueryCtx | MutationCtx, ownerId: string) {
  return !!await activeComplimentaryEntitlement(ctx, ownerId);
}

/** Ultra comes from an active Ultra subscription, or an operator grant on an active complimentary entitlement. */
export async function hasUltraPlan(ctx: QueryCtx | MutationCtx, ownerId: string) {
  if ((await activeAppleEntitlement(ctx, ownerId))?.plan === 'ultra') return true;
  if ((await activeComplimentaryEntitlement(ctx, ownerId))?.plan === 'ultra') return true;
  if (!billingEnabled() || !ultraBillingConfigured()) return false;
  return (await editorSubscriptions(ctx, ownerId)).some(sub => isUltraSubscription(sub) && hasEditorAccess(sub));
}

export async function requireEditorAccess(ctx: QueryCtx | MutationCtx, ownerId: string) {
  if (!billingEnabled()) return;
  if (await hasComplimentaryEditorAccess(ctx, ownerId)) return;
  if (await activeAppleEntitlement(ctx, ownerId)) return;
  if (!billingConfigured()) throw new ConvexError({ code: 'BILLING_UNAVAILABLE', message: 'Billing is temporarily unavailable. Please try again.' });
  if (!(await editorSubscriptions(ctx, ownerId)).some(hasEditorAccess)) {
    throw new ConvexError({ code: 'SUBSCRIPTION_REQUIRED', message: 'Start your free trial or renew your subscription to edit and export.' });
  }
}

/** Model upgrades require a current paid term or an operator-granted Ultra plan; trials and other
 * complimentary access only grant editing. Deployments without billing (development, agent
 * worktrees, self-hosted) meter no one, so every account keeps the configured models there. */
export async function hasPaidModelAccess(ctx: QueryCtx | MutationCtx, ownerId: string) {
  if (!billingEnabled()) return true;
  if (await hasPaidAppleModelAccess(ctx, ownerId)) return true;
  if ((await activeComplimentaryEntitlement(ctx, ownerId))?.plan === 'ultra') return true;
  if (!billingConfigured()) return false;
  return (await editorSubscriptions(ctx, ownerId)).some(hasPaidEditorSubscriptionTerm);
}

export type Plan = 'free' | 'mcp' | 'pro' | 'ultra';
export const PRO_REQUIRED_MESSAGE = 'Editing by prompting is part of Revline Pro. Upgrade to edit here, or keep editing from your MCP client.';

/** The account's plan. App Store and complimentary access are Pro (or Ultra); a Stripe account is MCP
 * only when every current subscription is the MCP price. Deployments without billing treat everyone as Pro. */
export async function currentPlan(ctx: QueryCtx | MutationCtx, ownerId: string): Promise<Plan> {
  if (await hasUltraPlan(ctx, ownerId)) return 'ultra';
  if (!billingEnabled() || await hasComplimentaryEditorAccess(ctx, ownerId) || await activeAppleEntitlement(ctx, ownerId)) return 'pro';
  if (!billingConfigured()) return 'free';
  const current = (await editorSubscriptions(ctx, ownerId)).filter(hasEditorAccess);
  return !current.length ? 'free' : current.every(isMcpSubscription) ? 'mcp' : 'pro';
}

/** Editing by prompting inside the app (the in-app editor agent) is Pro only; MCP members get the upgrade prompt. */
export async function requireInAppAgentAccess(ctx: QueryCtx | MutationCtx, ownerId: string) {
  await requireEditorAccess(ctx, ownerId);
  if (await currentPlan(ctx, ownerId) === 'mcp') throw new ConvexError({ code: 'PRO_REQUIRED', message: PRO_REQUIRED_MESSAGE });
}

/** For code both surfaces run: MCP runs (mcp- run ids, the same caller surface that keeps SAM 3.1 MCP-only)
 * need any editor plan; in-app runs need Pro. */
export async function requireRunPlan(ctx: QueryCtx | MutationCtx, ownerId: string, runId: string) {
  if (isMcpRun(runId)) await requireEditorAccess(ctx, ownerId);
  else await requireInAppAgentAccess(ctx, ownerId);
}
