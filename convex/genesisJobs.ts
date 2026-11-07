import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { runArgs } from './lib/active_run';
import { hasPaidModelAccess, requireEditorAccess } from './lib/billing_access';
import { requireMediaTaskCapacity } from './lib/account_limits';
import { enqueueMediaTask } from './lib/media_queue';
import { mediaUrl } from './lib/media_storage';
import { layerStatus, ownedLayer, requireMcpRun } from './genesis';
import { MEDIA_PROCESSOR_VERSION } from '../lib/media-analysis/processor-version';
import { DEPTH_MODEL, DEPTH_USD_PER_SECOND, LIGHTX_FRAMES, LIGHTX_OUTPUT_FPS, MAX_DEPTH_SECONDS, MAX_RELIGHT_SECONDS, RELIGHT_MONTHLY_SECONDS, RELIGHT_USD_PER_SECOND } from '../lib/ai/lanes/genesis/config';
import { genesisJobKind, genesisJobResult, type GenesisJobResult, type GenesisWork } from '../lib/ai/lanes/genesis/job';
import type { GenesisJobEvidence } from '../lib/ai/lanes/types';

/** Genesis (MCP only) media jobs: a reusable depth pass, a relight, or a depth effect. Outputs sit on the source clock. */
const DEPTH_HANDLE_SECONDS = .25;
const jobStatus = (job: Doc<'genesisJobs'>) => job.status === 'completed' && job.outputAssetId ? 'ready' as const : job.status === 'failed' ? 'failed' as const : 'processing' as const;
const round = (value: number) => Math.round(value * 1000) / 1000;
const cents = (value: number) => Math.round(value * 100) / 100;

async function ownedJob(ctx: QueryCtx | MutationCtx, args: { projectId: Id<'projects'>; ownerId: string }, jobId: string) {
  const id = ctx.db.normalizeId('genesisJobs', jobId), job = id ? await ctx.db.get(id) : null;
  if (!job || job.ownerId !== args.ownerId || job.projectId !== args.projectId) throw new ConvexError('Genesis job not found in this project. Use the jobId depth, relight or depthEffect returned.');
  return job;
}

/** The original footage behind a clip's media: Genesis results point back to it with derivedOf. */
async function rootAsset(ctx: QueryCtx | MutationCtx, asset: Doc<'assets'>) {
  if (!asset.derivedOf || asset.derivation) return asset;
  const root = await ctx.db.get(asset.derivedOf);
  return root && root.ownerId === asset.ownerId && root.projectId === asset.projectId ? root : asset;
}

/** Relight seconds this owner started this calendar month (UTC), failed jobs excluded. */
async function relightUsage(ctx: QueryCtx | MutationCtx, ownerId: string) {
  const now = new Date(), since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const jobs = await ctx.db.query('genesisJobs').withIndex('by_owner_kind_created', q => q.eq('ownerId', ownerId).eq('kind', 'relight').gte('createdAt', since)).take(500);
  const used = jobs.filter(job => job.status !== 'failed').reduce((sum, job) => sum + job.seconds, 0);
  const plan = await hasPaidModelAccess(ctx, ownerId) ? 'pro' as const : 'mcp' as const;
  return { plan, used: round(used), allowance: RELIGHT_MONTHLY_SECONDS[plan] };
}

export const startFromRun = internalMutation({
  args: { ...runArgs, kind: genesisJobKind, clipId: v.string(), assetId: v.string(), start: v.number(), end: v.number(), params: v.any(), layerIds: v.array(v.string()), depthId: v.optional(v.string()) },
  returns: v.object({ jobId: v.id('genesisJobs'), status: v.union(v.literal('processing'), v.literal('ready')), estimatedUsd: v.number(), reused: v.boolean(), allowance: v.optional(v.object({ plan: v.string(), usedSeconds: v.number(), monthlySeconds: v.number() })) }),
  handler: async (ctx, args) => {
    const project = await requireMcpRun(ctx, args, true);
    await requireEditorAccess(ctx, args.ownerId);
    const assetId = ctx.db.normalizeId('assets', args.assetId), asset = assetId ? await ctx.db.get(assetId) : null;
    if (!asset || asset.ownerId !== args.ownerId || asset.projectId !== project._id || asset.kind !== 'video' || !asset.duration) throw new ConvexError('This clip’s video is unavailable.');
    if (asset.cutoutOf) throw new ConvexError('This clip shows a cut-out. Use the original footage clip.');
    const root = await rootAsset(ctx, asset);
    // A depth pass reads the original footage; relights and effects change the pixels the clip shows now.
    const source = args.kind === 'depth' ? root : asset;
    const handle = args.kind === 'depth' ? DEPTH_HANDLE_SECONDS : 0;
    const start = Math.max(0, args.start - handle), end = Math.min(root.duration ?? asset.duration, args.end + handle), seconds = end - start;
    if (!(seconds > 0)) throw new ConvexError('Choose footage inside the clip.');
    if (args.kind === 'relight' && args.end - args.start > MAX_RELIGHT_SECONDS + 1e-3) throw new ConvexError(`Relight takes clips up to ${MAX_RELIGHT_SECONDS} s; this one plays ${(args.end - args.start).toFixed(1)} s of footage. Trim it, or split it and relight each part.`);
    if (args.kind !== 'relight' && args.end - args.start > MAX_DEPTH_SECONDS + 1e-3) throw new ConvexError(`Depth works on up to ${MAX_DEPTH_SECONDS} s at a time. Split the clip first.`);
    for (const layerId of args.layerIds) {
      const layer = await ownedLayer(ctx, args, layerId), status = layerStatus(await ctx.db.get(layer.cutoutId));
      if (status !== 'ready') throw new ConvexError(`Layer ${layerId} is ${status}. Poll getLayer until ready${status === 'failed' ? ', or segment again' : ''}.`);
      if (layer.sourceAssetId !== root._id) throw new ConvexError(`Layer ${layerId} was segmented from other footage. Segment this clip.`);
      if (layer.start > args.start + 1 / layer.fps || layer.end < args.end - 1 / layer.fps) throw new ConvexError(`Layer ${layerId} masks ${layer.start.toFixed(2)}–${layer.end.toFixed(2)}s of source but the clip plays ${args.start.toFixed(2)}–${args.end.toFixed(2)}s. Segment the whole clip.`);
    }
    if (args.depthId) {
      const depth = await ownedJob(ctx, args, args.depthId);
      if (depth.kind !== 'depth') throw new ConvexError(`${args.depthId} is a ${depth.kind} job, not a depth pass.`);
      if (jobStatus(depth) !== 'ready') throw new ConvexError(`Depth pass ${args.depthId} is ${jobStatus(depth)}. Poll getJob until ready${jobStatus(depth) === 'failed' ? ', or run depth again' : ''}.`);
      if (depth.sourceAssetId !== root._id || depth.start > args.start + 1e-3 || depth.end < args.end - 1e-3) throw new ConvexError(`Depth pass ${args.depthId} does not cover this clip's footage. Run depth on this clip.`);
    }
    const key = JSON.stringify({ kind: args.kind, asset: source._id, start: round(start), end: round(end), params: args.params, layers: [...args.layerIds].sort(), depth: args.depthId ?? null });
    const usage = args.kind === 'relight' ? await relightUsage(ctx, args.ownerId) : undefined;
    const allowance = usage ? { plan: usage.plan, usedSeconds: usage.used, monthlySeconds: usage.allowance } : undefined;
    for (const job of await ctx.db.query('genesisJobs').withIndex('by_project', q => q.eq('projectId', project._id)).order('desc').take(100)) {
      if (job.ownerId !== args.ownerId || job.status === 'failed') continue;
      // A depth pass covering the range serves any clip of the same footage.
      const same = args.kind === 'depth' ? job.kind === 'depth' && job.sourceAssetId === source._id && job.start <= start + 1e-3 && job.end >= end - 1e-3 : job.key === key;
      if (same) return { jobId: job._id, status: jobStatus(job) === 'ready' ? 'ready' as const : 'processing' as const, estimatedUsd: 0, reused: true, ...(allowance ? { allowance } : {}) };
    }
    if (usage && usage.used + seconds > usage.allowance + 1e-3) throw new ConvexError(`Monthly relight allowance reached: ${usage.used.toFixed(1)} of ${usage.allowance} relight seconds used this month on the ${usage.plan === 'pro' ? 'Pro' : 'MCP'} plan, and this clip needs ${seconds.toFixed(1)} s. It resets on the 1st (UTC). Relight a shorter part, or wait.`);
    await requireMediaTaskCapacity(ctx, args.ownerId, 1);
    // One LightX call per clip: 49 frames returned at 10 fps are billed as 4.9 output seconds.
    const estimatedUsd = args.kind === 'depth' ? cents(Math.max(.01, seconds * DEPTH_USD_PER_SECOND)) : args.kind === 'relight' ? cents(LIGHTX_FRAMES / LIGHTX_OUTPUT_FPS * RELIGHT_USD_PER_SECOND) : 0;
    const jobId = await ctx.db.insert('genesisJobs', { ownerId: args.ownerId, projectId: project._id, clipId: args.clipId, kind: args.kind, sourceAssetId: source._id, rootAssetId: root._id, start, end, seconds, params: args.params, layerIds: args.layerIds, ...(args.depthId ? { depthId: args.depthId as Id<'genesisJobs'> } : {}), key, status: 'queued', estimatedUsd, applications: [], createdAt: Date.now() });
    const taskId = await enqueueMediaTask(ctx, { ownerId: args.ownerId, projectId: project._id, assetId: source._id, kind: 'genesis', genesisJobId: jobId, requiredProcessorVersion: MEDIA_PROCESSOR_VERSION });
    await ctx.db.patch(jobId, { taskId });
    return { jobId, status: 'processing' as const, estimatedUsd, reused: false, ...(allowance ? { allowance: { ...allowance, usedSeconds: round(allowance.usedSeconds + seconds) } } : {}) };
  },
});

export const jobForRun = internalQuery({
  args: { ...runArgs, jobId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, false);
    const job = await ownedJob(ctx, args, args.jobId), status = jobStatus(job);
    const task = status === 'processing' && job.taskId ? await ctx.db.get(job.taskId) : null;
    const model = job.kind === 'depth' ? `Video Depth Anything ${DEPTH_MODEL} (fal)` : job.kind === 'relight' ? 'LightX relight (fal)' : 'Genesis depth compositor (media worker)';
    return {
      jobId: job._id, kind: job.kind, status, ...(status === 'failed' ? { error: job.error ?? 'The job stopped. Start it again.' } : {}), ...(task ? { progress: task.progress ?? 0 } : {}),
      clipId: job.clipId, source: { start: job.start, end: job.end }, model, ...(job.mode ? { mode: job.mode } : {}), params: job.params,
      ...(job.readyAt ? { costUsd: job.costUsd ?? 0, ...(job.calls ? { falCalls: job.calls } : {}), latencySeconds: Math.round((job.readyAt - job.createdAt) / 100) / 10 } : { estimatedUsd: job.estimatedUsd }),
      ...(job.kind === 'depth' ? {} : { applications: job.applications }),
      next: status === 'processing' ? 'Call getJob again in 15-30 seconds.' : status === 'failed' ? 'Fix the cause in error, then start the job again.' : job.kind === 'depth' ? 'Use this jobId as depthId in depthEffect or relight.' : 'applyJob with this jobId, then getFrames at full resolution.',
    };
  },
});

/** A ready relight/effect result and the source range a clip must play to use it. */
export const readyForApply = internalQuery({
  args: { ...runArgs, jobId: v.string() },
  returns: v.object({ jobId: v.string(), kind: genesisJobKind, clipId: v.string(), sourceAssetId: v.string(), outputAssetId: v.string(), start: v.number(), end: v.number() }),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, false);
    const job = await ownedJob(ctx, args, args.jobId), status = jobStatus(job);
    if (job.kind === 'depth') throw new ConvexError('A depth pass is not applied itself. Pass it as depthId to depthEffect or relight.');
    if (status !== 'ready') throw new ConvexError(status === 'failed' ? `Job ${job._id} failed: ${job.error ?? 'unknown error'}. Start it again.` : `Job ${job._id} is still processing. Poll getJob until ready.`);
    return { jobId: job._id, kind: job.kind, clipId: job.clipId, sourceAssetId: job.sourceAssetId, outputAssetId: job.outputAssetId!, start: job.start, end: job.end };
  },
});

export const recordApplication = internalMutation({
  args: { ...runArgs, jobId: v.string(), timelineId: v.string(), clipId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, true);
    const job = await ownedJob(ctx, args, args.jobId);
    await ctx.db.patch(job._id, { applications: [...job.applications, { timelineId: args.timelineId, clipId: args.clipId, at: Date.now() }].slice(-50) });
    return null;
  },
});

/** Applied relights and effects, for the genesis lane's finish checks. */
export const forCheck = internalQuery({
  args: { ownerId: v.string(), projectId: v.id('projects') },
  returns: v.array(v.object({ jobId: v.string(), kind: v.string(), outputAssetId: v.string(), start: v.number(), end: v.number(), applications: v.array(v.object({ timelineId: v.string(), clipId: v.string() })) })),
  handler: async (ctx, args): Promise<GenesisJobEvidence[]> => {
    const jobs = await ctx.db.query('genesisJobs').withIndex('by_project', q => q.eq('projectId', args.projectId)).order('desc').take(100);
    return jobs.filter(job => job.ownerId === args.ownerId && job.outputAssetId && job.applications.length)
      .map(job => ({ jobId: job._id, kind: job.kind, outputAssetId: job.outputAssetId!, start: job.start, end: job.end, applications: job.applications.map(({ at: _at, ...use }) => use) }));
  },
});

/** What the worker needs for a Genesis task: the job, signed mask URLs of its layers and the depth pass. */
export async function genesisWorkFor(ctx: QueryCtx | MutationCtx, task: Doc<'mediaTasks'>): Promise<GenesisWork> {
  const job = task.genesisJobId ? await ctx.db.get(task.genesisJobId) : null;
  if (!job || job.ownerId !== task.ownerId || job.projectId !== task.projectId) throw new ConvexError('The Genesis job is unavailable.');
  const masks = await Promise.all(job.layerIds.map(async layerId => {
    const layer = await ownedLayer(ctx, job, layerId), cutout = await ctx.db.get(layer.cutoutId), output = cutout?.outputAssetId ? await ctx.db.get(cutout.outputAssetId) : null;
    if (!output || output.ownerId !== job.ownerId) throw new ConvexError(`Layer ${layerId} lost its mask. Segment again.`);
    const url = await mediaUrl(ctx, output, true);
    if (!url) throw new ConvexError(`Layer ${layerId}'s mask is not stored. Segment again.`);
    return { layerId, url };
  }));
  const depth = job.depthId ? await ctx.db.get(job.depthId) : null, depthAsset = depth?.outputAssetId ? await ctx.db.get(depth.outputAssetId) : null;
  if (job.depthId && (!depthAsset || depthAsset.ownerId !== job.ownerId)) throw new ConvexError('The depth pass is unavailable. Run depth again.');
  const depthUrl = depthAsset ? await mediaUrl(ctx, depthAsset, true) : undefined;
  if (depthAsset && !depthUrl) throw new ConvexError('The depth pass is not stored. Run depth again.');
  return { job: job.kind, start: job.start, end: job.end, params: job.params, ...(masks.length ? { masks } : {}), ...(depthUrl ? { depthUrl } : {}) };
}

export const isActive = async (ctx: QueryCtx | MutationCtx, task: Doc<'mediaTasks'>) => {
  const job = task.genesisJobId ? await ctx.db.get(task.genesisJobId) : null;
  return !!job && job.ownerId === task.ownerId && job.projectId === task.projectId && job.status === 'queued';
};

export const failJob = async (ctx: MutationCtx, task: Doc<'mediaTasks'>, error: string) => {
  const job = task.genesisJobId ? await ctx.db.get(task.genesisJobId) : null;
  if (job && job.status === 'queued') await ctx.db.patch(job._id, { status: 'failed', error: error.slice(0, 1000) });
};

/** The worker stored the result: keep it on the original's source clock with its sound, and record the real cost. */
export async function completeGenesisJob(ctx: MutationCtx, task: Doc<'mediaTasks'>, result: GenesisJobResult | undefined) {
  const job = task.genesisJobId ? await ctx.db.get(task.genesisJobId) : null;
  const output = task.outputAssetId ? await ctx.db.get(task.outputAssetId) : null;
  if (!job || job.status !== 'queued') throw new ConvexError('The Genesis job is no longer active.');
  if (!output || output.ownerId !== task.ownerId || output.projectId !== task.projectId || output.kind !== 'video' || !output.duration) throw new ConvexError('The Genesis result has not been stored yet.');
  const root = await ctx.db.get(job.rootAssetId);
  // Relights and effects play in place of the footage (derivedOf, with its sound); a depth pass is data, never footage.
  if (job.kind !== 'depth') await ctx.db.patch(output._id, { derivedOf: job.rootAssetId, derivedStart: job.start, audioExtracted: true, ...(root?.audioAssetId ? { audioAssetId: root.audioAssetId } : {}) });
  // A retried task whose upload already landed has no receipt; its estimate stands in for the cost.
  const costUsd = result ? cents(result.billedSeconds * (job.kind === 'depth' ? DEPTH_USD_PER_SECOND : job.kind === 'relight' ? RELIGHT_USD_PER_SECOND : 0)) : job.estimatedUsd;
  await ctx.db.patch(job._id, { status: 'completed', outputAssetId: output._id, costUsd, ...(result?.mode ? { mode: result.mode } : {}), ...(result?.calls ? { calls: result.calls } : {}), readyAt: Date.now() });
}

export { genesisJobResult };
