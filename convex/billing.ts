import { StripeSubscriptions } from "@convex-dev/stripe";
import Stripe from 'stripe';
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalMutation, query, type ActionCtx } from "./_generated/server";
import { EDITOR_PLAN, MCP_PLAN, ULTRA_OFFERED, ULTRA_PLAN } from "../lib/billing/plan";
import { NEW_PROJECT_PATH } from '../lib/workspace-routes';
import { billingConfigured, billingEnabled, editorSubscriptions, hasComplimentaryEditorAccess, hasEditorAccess, hasUltraPlan, isEditorSubscription, isMcpSubscription, mcpBillingConfigured, ultraBillingConfigured } from './lib/billing_access';
import { activeAppleEntitlement } from './lib/apple_entitlements';

function ready() { return billingEnabled() && billingConfigured(); }
type PaidPlan = 'pro' | 'ultra' | 'mcp';
const paidPlan = v.union(v.literal("pro"), v.literal("ultra"), v.literal("mcp"));
function requireBilling(plan: PaidPlan = 'pro') {
  if (!ready()) throw new ConvexError("Billing is not active");
  if (plan === 'ultra' && (!ULTRA_OFFERED || !process.env.STRIPE_ULTRA_PRICE_ID?.startsWith("price_"))) throw new ConvexError("Ultra is not available yet");
  if (plan === 'mcp' && !process.env.STRIPE_MCP_PRICE_ID?.startsWith("price_")) throw new ConvexError("Revline MCP is not available yet");
  const origin = new URL(process.env.APP_ORIGIN!);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw new ConvexError("Billing origin is invalid");
  if (!process.env.STRIPE_PRO_PRICE_ID!.startsWith("price_")) throw new ConvexError("Billing price is not configured");
  return origin.origin;
}
export const status = query({ args: {}, returns: v.object({ enabled: v.boolean(), configured: v.boolean(), subscribed: v.boolean(), complimentary: v.optional(v.boolean()), complimentaryExpiresAt: v.optional(v.number()), trialEligible: v.boolean(), needsPayment: v.boolean(), paymentIssue: v.optional(v.boolean()), subscriptionSource: v.optional(v.union(v.literal('apple'), v.literal('stripe'))), appleExpiresAt: v.optional(v.number()), plan: v.union(v.literal("free"), v.literal("mcp"), v.literal("pro"), v.literal("ultra")), ultraAvailable: v.boolean(), mcpAvailable: v.boolean(), trialing: v.optional(v.boolean()) }), handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity(); let subscribed = false; let trialEligible = true; let paymentIssue = false; let mcpOnly = false; let trialing = false;
  const complimentary = !!identity && await hasComplimentaryEditorAccess(ctx, identity.subject);
  const ultra = !!identity && await hasUltraPlan(ctx, identity.subject);
  const apple = identity ? await activeAppleEntitlement(ctx, identity.subject) : null;
  if (identity && ready()) { const subs = await editorSubscriptions(ctx, identity.subject); const current = subs.filter(hasEditorAccess); subscribed = current.length > 0; mcpOnly = subscribed && current.every(isMcpSubscription); trialing = current.some(sub => sub.status === 'trialing'); trialEligible = subs.length === 0; paymentIssue = subs.some(sub => ['past_due', 'unpaid', 'paused', 'incomplete'].includes(sub.status)); }
  const stripeSubscribed = subscribed;
  const subscriptionSource: 'apple' | 'stripe' | undefined = apple ? 'apple' : stripeSubscribed ? 'stripe' : undefined;
  subscribed ||= !!apple;
  // App Store and complimentary access are Pro; only a Stripe MCP subscription alone is the MCP plan.
  const plan: 'ultra' | 'pro' | 'mcp' | 'free' = ultra ? 'ultra' : complimentary || apple ? 'pro' : mcpOnly ? 'mcp' : subscribed ? 'pro' : 'free';
  const entitlement = complimentary ? await ctx.db.query('editorEntitlements').withIndex('by_owner', q => q.eq('ownerId', identity!.subject)).unique() : null;
  return { enabled: billingEnabled(), configured: ready() || !!apple, subscribed, ...(subscriptionSource ? { subscriptionSource } : {}), ...(apple ? { appleExpiresAt: apple.accessUntil } : {}), ...(complimentary ? { complimentary: true, ...(entitlement?.expiresAt !== undefined ? { complimentaryExpiresAt: entitlement.expiresAt } : {}) } : {}), trialEligible: complimentary || apple ? false : trialEligible, needsPayment: !!identity && billingEnabled() && !subscribed && !complimentary, paymentIssue: !subscribed && !complimentary && paymentIssue, plan, ultraAvailable: ready() && ultraBillingConfigured(), mcpAvailable: ready() && mcpBillingConfigured(), ...(trialing && !apple ? { trialing: true } : {}) };
}});
export const reserveCheckout = internalMutation({
  args: { ownerId: v.string(), priceId: v.string(), origin: v.string(), trialEligible: v.boolean(), expiredRequestId: v.optional(v.string()) },
  returns: v.object({ requestId: v.string(), sessionId: v.optional(v.string()), url: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const previous = await ctx.db.query('billingCheckouts').withIndex('by_owner', q => q.eq('ownerId', args.ownerId)).unique();
    if (previous && previous.priceId === args.priceId && previous.origin === args.origin && previous.trialEligible === args.trialEligible && previous.requestId !== args.expiredRequestId && (previous.expiresAt ?? previous.createdAt + 23 * 3600_000) > Date.now()) {
      return { requestId: previous.requestId, sessionId: previous.sessionId, url: previous.url };
    }
    const fields = { ownerId: args.ownerId, priceId: args.priceId, origin: args.origin, trialEligible: args.trialEligible, requestId: crypto.randomUUID(), createdAt: Date.now() };
    if (previous) await ctx.db.replace(previous._id, fields); else await ctx.db.insert('billingCheckouts', fields);
    return { requestId: fields.requestId };
  },
});
export const saveCheckout = internalMutation({
  args: { ownerId: v.string(), requestId: v.string(), sessionId: v.string(), url: v.string(), expiresAt: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    const checkout = await ctx.db.query('billingCheckouts').withIndex('by_owner', q => q.eq('ownerId', args.ownerId)).unique();
    if (checkout?.requestId === args.requestId) await ctx.db.patch(checkout._id, { sessionId: args.sessionId, url: args.url, expiresAt: args.expiresAt });
    return null;
  },
});
// Claim before the Stripe read, so a slower concurrent response cannot overwrite
// a later reconciliation. Stripe event.created has only second precision.
export const beginSubscriptionSync = internalMutation({
  args: { stripeSubscriptionId: v.string(), eventId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const previous = await ctx.db.query('billingSubscriptionSync').withIndex('by_subscription', q => q.eq('stripeSubscriptionId', args.stripeSubscriptionId)).unique();
    if (previous?.lastEventId === args.eventId) return null;
    const token = crypto.randomUUID();
    if (previous) await ctx.db.patch(previous._id, { token });
    else await ctx.db.insert('billingSubscriptionSync', { stripeSubscriptionId: args.stripeSubscriptionId, token });
    return token;
  },
});
export const applySubscriptionSync = internalMutation({
  args: { stripeSubscriptionId: v.string(), eventId: v.string(), token: v.string(), stripeCustomerId: v.string(), status: v.string(), currentPeriodEnd: v.number(), cancelAtPeriodEnd: v.boolean(), cancelAt: v.optional(v.number()), quantity: v.number(), priceId: v.string(), metadata: v.record(v.string(), v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { token, eventId, ...subscription }) => {
    const claim = await ctx.db.query('billingSubscriptionSync').withIndex('by_subscription', q => q.eq('stripeSubscriptionId', subscription.stripeSubscriptionId)).unique();
    if (!claim || claim.token !== token) return false;
    // Component writes and this receipt commit in the same transaction. Updated
    // also upserts, covering cancellation delivered before the creation event.
    await ctx.runMutation(components.stripe.private.handleSubscriptionUpdated, subscription);
    await ctx.db.patch(claim._id, { lastEventId: eventId });
    return true;
  },
});
async function verifiedPrice(client: Stripe, plan: PaidPlan) {
  const priceId = plan === 'ultra' ? process.env.STRIPE_ULTRA_PRICE_ID! : plan === 'mcp' ? process.env.STRIPE_MCP_PRICE_ID! : process.env.STRIPE_PRO_PRICE_ID!;
  const amount = (plan === 'ultra' ? ULTRA_PLAN : plan === 'mcp' ? MCP_PLAN : EDITOR_PLAN).monthlyPrice * 100;
  const price = await client.prices.retrieve(priceId);
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== amount || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) throw new ConvexError('Billing price does not match the plan.');
  return priceId;
}
export const createCheckout = action({ args: { plan: paidPlan }, returns: v.object({ sessionId: v.string(), url: v.union(v.string(), v.null()) }), handler: async (ctx, { plan }): Promise<{sessionId: string; url: string | null}> => {
  const identity = await ctx.auth.getUserIdentity(); if (!identity) throw new ConvexError("Authentication required");
  if (await ctx.runQuery(internal.editorAccess.hasComplimentary, { ownerId: identity.subject })) throw new ConvexError('Your complimentary membership already includes editor access. No payment is required.');
  if (await ctx.runQuery(internal.appleBilling.hasActive, { ownerId: identity.subject })) throw new ConvexError('Your subscription is managed in the App Store.');
  const origin = requireBilling(plan); const stripe = new StripeSubscriptions(components.stripe, {});
  const subscriptions = await editorSubscriptions(ctx, identity.subject);
  if (subscriptions.some(hasEditorAccess)) throw new ConvexError(plan === 'ultra' ? "You already have a subscription. Upgrade it to Ultra from billing." : "You already have a subscription. Manage it in billing.");
  if (subscriptions.some(sub => ['past_due', 'unpaid', 'paused', 'incomplete'].includes(sub.status))) throw new ConvexError('Update your existing subscription in billing before creating a new one.');
  // Only identity.subject selects a customer. Email fallback can alias unrelated identities.
  const customer = await stripe.getOrCreateCustomer(ctx, { userId: identity.subject });
  const client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const priceId = await verifiedPrice(client, plan);
  // Also check Stripe directly so delayed webhooks cannot create duplicate subscriptions or trials.
  const remote = await client.subscriptions.list({ customer: customer.customerId, status: 'all', limit: 100 });
  if (remote.has_more) throw new ConvexError('Please manage your existing subscriptions in billing.');
  const editor = remote.data.filter(sub => isEditorSubscription({ priceId: sub.items.data[0]?.price.id ?? '', metadata: sub.metadata }));
  if (editor.some(sub => !['canceled', 'incomplete_expired'].includes(sub.status))) throw new ConvexError('You already have a subscription. Manage it in billing.');
  // Pro and MCP start with the same trial, once per account; Ultra has none.
  const reservationArgs = { ownerId: identity.subject, priceId, origin, trialEligible: plan !== 'ultra' && subscriptions.length === 0 && editor.length === 0 };
  let reservation = await ctx.runMutation(internal.billing.reserveCheckout, reservationArgs);
  if (reservation.sessionId) {
    const previous = await client.checkout.sessions.retrieve(reservation.sessionId);
    if (previous.status === 'open' && previous.url) return { sessionId: previous.id, url: previous.url };
    if (previous.status === 'complete') throw new ConvexError('Your checkout is complete. Waiting for Stripe to confirm your membership.');
    reservation = await ctx.runMutation(internal.billing.reserveCheckout, { ...reservationArgs, expiredRequestId: reservation.requestId });
  }
  const session = await client.checkout.sessions.create({
    mode: 'subscription', customer: customer.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}${NEW_PROJECT_PATH}?checkout=success`, cancel_url: `${origin}/billing?checkout=canceled`,
    integration_identifier: 'revline-editor-xpkzqvna', payment_method_collection: 'always',
    managed_payments: { enabled: false },
    metadata: { userId: identity.subject, app: 'revline-editor' },
    subscription_data: {
      metadata: { userId: identity.subject, app: 'revline-editor', ...(plan === 'mcp' ? { plan: 'mcp' } : {}) },
      ...(reservationArgs.trialEligible ? { trial_period_days: plan === 'mcp' ? MCP_PLAN.trialDays : EDITOR_PLAN.trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } } } : {}),
    },
  }, { idempotencyKey: `revline-checkout-v2-${reservation.requestId}` });
  if (!session.url) throw new ConvexError('Stripe did not return a checkout link.');
  await ctx.runMutation(internal.billing.saveCheckout, { ownerId: identity.subject, requestId: reservation.requestId, sessionId: session.id, url: session.url, expiresAt: session.expires_at * 1000 });
  return { sessionId: session.id, url: session.url };
}});
export const createPortal = action({ args: {}, returns: v.object({ url: v.string() }), handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity(); if (!identity) throw new ConvexError("Authentication required");
  if (await ctx.runQuery(internal.editorAccess.hasComplimentary, { ownerId: identity.subject })) throw new ConvexError('Your complimentary membership does not require a billing portal.');
  const origin = requireBilling();
  const customer = await ctx.runQuery(components.stripe.public.getCustomerByUserId, { userId: identity.subject });
  if (!customer) throw new ConvexError("No billing account exists");
  return await new StripeSubscriptions(components.stripe, {}).createCustomerPortalSession(ctx, { customerId: customer.stripeCustomerId, returnUrl: `${origin}/billing` });
}});
/** Moves the one active editor subscription to a higher plan's price in place; the webhook then syncs the plan.
 *  A paid term is invoiced the prorated difference now. Ultra has no trial, so it ends one; Pro keeps a running trial. */
async function upgradeTo(ctx: ActionCtx, plan: 'pro' | 'ultra') {
  const identity = await ctx.auth.getUserIdentity(); if (!identity) throw new ConvexError("Authentication required");
  if (await ctx.runQuery(internal.appleBilling.hasActive, { ownerId: identity.subject })) throw new ConvexError('Manage or upgrade your subscription in the App Store.');
  requireBilling(plan);
  const customer = await ctx.runQuery(components.stripe.public.getCustomerByUserId, { userId: identity.subject });
  if (!customer) throw new ConvexError('Start a membership before upgrading.');
  const client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const priceId = await verifiedPrice(client, plan);
  const remote = await client.subscriptions.list({ customer: customer.stripeCustomerId, status: 'all', limit: 100 });
  const current = remote.data.filter(sub => ['active', 'trialing'].includes(sub.status) && isEditorSubscription({ priceId: sub.items.data[0]?.price.id ?? '', metadata: sub.metadata }));
  if (current.length !== 1 || current[0].items.data.length !== 1) throw new ConvexError('Please manage your subscription in billing.');
  const [subscription] = current, [item] = subscription.items.data;
  if (item.price.id === priceId) return null;
  // Pro is an upgrade only from MCP; Ultra already sits above it.
  if (plan === 'pro' && !isMcpSubscription({ priceId: item.price.id, metadata: subscription.metadata })) throw new ConvexError('Please manage your subscription in billing.');
  const keepTrial = plan === 'pro' && subscription.status === 'trialing';
  try {
    await client.subscriptions.update(subscription.id, {
      items: [{ id: item.id, price: priceId, quantity: 1 }],
      proration_behavior: keepTrial ? 'none' : 'always_invoice', payment_behavior: 'error_if_incomplete', cancel_at_period_end: false,
      // An empty value removes the MCP tag, so the upgraded subscription reads as its new plan.
      ...(subscription.metadata.plan ? { metadata: { plan: '' } } : {}),
      ...(subscription.status === 'trialing' && !keepTrial ? { trial_end: 'now' as const } : {}),
    });
  } catch (error) {
    // No idempotency key: a retry after fixing the card must reach Stripe again, and
    // the price check above already makes a repeated upgrade a no-op.
    if (error instanceof Stripe.errors.StripeCardError) throw new ConvexError('Your card was declined. Update your payment method in billing, then try again.');
    throw error;
  }
  return null;
}
export const upgradeToUltra = action({ args: {}, returns: v.null(), handler: async (ctx) => upgradeTo(ctx, 'ultra') });
/** Revline MCP to Pro, for editing by prompting inside the app. */
export const upgradeToPro = action({ args: {}, returns: v.null(), handler: async (ctx) => upgradeTo(ctx, 'pro') });
