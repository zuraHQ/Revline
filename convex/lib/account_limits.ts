import { ConvexError } from 'convex/values';
import { initializeMediaCapacity } from './media_task_data';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { FAIR_USE_LABELS, FAIR_USE_MONTHLY, type FairUseKind } from '../../lib/billing/plan';
import { billingEnabled } from './billing_access';

const MINUTE_MS = 60_000;
/** One video needs three tasks (extract, preview, then transcribe),
 * so the default admits eight sources transferring and preparing at once. */
const DEFAULT_MAX_ACTIVE_MEDIA_TASKS = 24;
/** Fresh preparation tasks queued by one source upload. */
export const uploadPreparationTasks = (kind: 'video' | 'audio' | 'image' | 'model') => kind === 'video' ? 3 : kind === 'audio' ? 2 : 0;

/** An abandoned transfer stops holding capacity after this; its completion still meets the ceiling. */
export const UPLOAD_RESERVATION_MS = 3600_000;

/** Operator override from Convex env, validated, else the default. */
export function accountLimit(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
const activeMediaTaskLimit = () => accountLimit('MAX_ACTIVE_MEDIA_TASKS_PER_ACCOUNT', DEFAULT_MAX_ACTIVE_MEDIA_TASKS, 3, 200);

/** Outstanding (queued, running, retrying) worker tasks across all of an owner's projects. */
async function activeMediaTasks(ctx: QueryCtx | MutationCtx, ownerId: string, cap: number) {
  return (await ctx.db.query('mediaTaskSlots').withIndex('by_owner', q => q.eq('ownerId', ownerId)).take(cap)).length;
}
/** Recent source transfers hold the preparation tasks they will queue, so
 * parallel starts cannot each see an empty account and move their bytes. */
async function reservedByUploads(ctx: QueryCtx | MutationCtx, ownerId: string, cap: number) {
  const now = Date.now();
  const leases = await ctx.db.query('r2Uploads').withIndex('by_owner_completed', q => q.eq('ownerId', ownerId).eq('completed', false)).filter(q => q.and(q.eq(q.field('taskId'), undefined), q.eq(q.field('jobId'), undefined), q.neq(q.field('kind'), 'image'), q.gt(q.field('_creationTime'), now - UPLOAD_RESERVATION_MS), q.gt(q.field('expiresAt'), now))).take(cap);
  return leases.reduce((count, lease) => count + uploadPreparationTasks(lease.kind), 0);
}
/** User-initiated work must fit beside the account's outstanding tasks and
 * transfers. The reads share the caller's transaction, so parallel requests
 * cannot race past it. Follow-up tasks of accepted work never call this and are
 * never dropped. `ceiling` widens the limit where an earlier check already
 * applied it; a finishing upload passes `countUploads: false` to skip itself. */
export async function hasMediaTaskCapacity(ctx: QueryCtx | MutationCtx, ownerId: string, incoming: number, { ceiling = 1, countUploads = true }: { ceiling?: number; countUploads?: boolean } = {}) {
  const limit = activeMediaTaskLimit(), allowed = limit * ceiling;
  if (incoming <= 0) return true;
  const initialized = await initializeMediaCapacity(ctx, ownerId);
  const legacy = initialized ? 0 : (await Promise.all((['queued', 'running', 'retrying'] as const).map(status => ctx.db.query('mediaTasks').withIndex('by_owner_status', q => q.eq('ownerId', ownerId).eq('status', status)).take(allowed)))).reduce((count, tasks) => count + tasks.length, 0);
  const used = (initialized ? await activeMediaTasks(ctx, ownerId, allowed) : legacy) + (countUploads ? await reservedByUploads(ctx, ownerId, allowed) : 0);
  return used + incoming <= allowed;
}

export async function requireMediaTaskCapacity(ctx: QueryCtx | MutationCtx, ownerId: string, incoming: number, options: { ceiling?: number; countUploads?: boolean } = {}) {
  if (!await hasMediaTaskCapacity(ctx, ownerId, incoming, options)) throw new ConvexError(`Your account has too many media jobs processing (up to ${activeMediaTaskLimit()} at once). Wait for some to finish, then try again.`);
}

type Quota = { period: number; max: number; message: string | ConvexError<{ code: string; message: string }>; windowStart?: (now: number) => number };
/** Fixed windows aligned to UTC minutes and days (or a quota's own windowStart). One row per
 * owner, name and period keeps each check to a single indexed read; a refused request rolls
 * back with its mutation and consumes nothing. */
async function consumeAccountQuota(ctx: MutationCtx, ownerId: string, name: string, quotas: readonly Quota[], amount = 1) {
  const now = Date.now();
  for (const quota of quotas) {
    const windowStart = quota.windowStart?.(now) ?? now - now % quota.period;
    const row = await ctx.db.query('accountRateLimits').withIndex('by_owner_name_period', q => q.eq('ownerId', ownerId).eq('name', name).eq('period', quota.period)).unique();
    const count = row && row.windowStart === windowStart ? row.count : 0;
    if (count + amount > quota.max) throw typeof quota.message === 'string' ? new ConvexError(quota.message) : quota.message;
    if (row) await ctx.db.patch(row._id, { windowStart, count: count + amount });
    else await ctx.db.insert('accountRateLimits', { ownerId, name, period: quota.period, windowStart, count: amount });
  }
}

/** Keys the monthly rows apart from the minute and day windows; the window itself is the UTC calendar month. */
const MONTH_PERIOD = 31 * 24 * MINUTE_MS * 60;
const utcMonthStart = (now: number) => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); };

/** Fair use on per-run paid work (lib/billing/plan.ts FAIR_USE_MONTHLY), for every plan. Counted when a
 * run is queued, so reused results cost nothing. Deployments without billing meter no one, as with model access. */
export async function consumeFairUse(ctx: MutationCtx, ownerId: string, kind: FairUseKind, amount = 1) {
  const cap: number | null = FAIR_USE_MONTHLY[kind];
  if (!billingEnabled() || amount <= 0) return;
  // An uncapped kind still records its monthly usage, so a later cap starts from real numbers.
  const max = cap ?? Number.MAX_SAFE_INTEGER;
  const message = `This would pass this month's allowance of ${max} ${FAIR_USE_LABELS[kind]}. Ask for fewer, or wait until it resets on the 1st (UTC).`;
  await consumeAccountQuota(ctx, ownerId, `fairUse:${kind}`, [{ period: MONTH_PERIOD, max, windowStart: utcMonthStart, message: new ConvexError({ code: 'FAIR_USE_LIMIT', message }) }], amount);
}

// Burst limits only: members have no daily caps on imports or AI requests.
export async function consumeVideoImport(ctx: MutationCtx, ownerId: string, createsProject: boolean) {
  const imports = accountLimit('VIDEO_IMPORTS_PER_MINUTE_PER_ACCOUNT', 10, 1, 100);
  await consumeAccountQuota(ctx, ownerId, 'videoImport', [{ period: MINUTE_MS, max: imports, message: 'You are importing video links too quickly. Wait a minute, then try again.' }]);
  if (!createsProject) return;
  const projects = accountLimit('IMPORT_PROJECTS_PER_MINUTE_PER_ACCOUNT', 5, 1, 100);
  await consumeAccountQuota(ctx, ownerId, 'importProject', [{ period: MINUTE_MS, max: projects, message: 'You are creating edits from video links too quickly. Wait a minute, or import into an existing edit.' }]);
}

/** Counted at submission, so a queued message is charged once, when sent. */
export async function consumeAssistantRequest(ctx: MutationCtx, ownerId: string) {
  const perMinute = accountLimit('AI_REQUESTS_PER_MINUTE_PER_ACCOUNT', 20, 1, 120);
  await consumeAccountQuota(ctx, ownerId, 'assistantRequest', [{ period: MINUTE_MS, max: perMinute, message: 'You are sending AI requests too quickly. Wait a minute, then try again.' }]);
}

/** Shared by narration, voice samples and sound effects, including provider retries. */
export async function consumeAudioRequest(ctx: MutationCtx, ownerId: string) {
  const perMinute = accountLimit('AUDIO_REQUESTS_PER_MINUTE_PER_ACCOUNT', 12, 1, 120);
  await consumeAccountQuota(ctx, ownerId, 'audioRequest', [{ period: MINUTE_MS, max: perMinute, message: 'You are generating audio too quickly. Wait a minute, then try again.' }]);
}
