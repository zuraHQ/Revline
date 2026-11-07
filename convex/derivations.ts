import { subjectSelectionValidator } from './lib/pixel_track_validator';
import { MEDIA_PROCESSOR_VERSION } from '../lib/media-analysis/processor-version';
import { pixelTrackRequestValidator, pixelTrackResultValidator } from './lib/pixel_track_validator';
import { forSurface, subjectSelection, subjectSelectionKey, pixelTrackRequest, parsePixelTrackResult, type PixelTrackRequest, type PixelTrackResult } from '../lib/media-analysis/pixel-track';
import { ConvexError, v } from 'convex/values';
import { runArgs } from './lib/active_run';
import { isMcpRun } from './lib/run_ids';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { requireEditorAccess } from './lib/billing_access';
import { requireMediaTaskCapacity } from './lib/account_limits';
import { readProject } from './lib/project_data';
import { commitTimeline, currentTimeline } from './lib/timeline';
import { editingWorkflowActive } from './lib/assistant_workflow';
import { enqueueMediaTask } from './lib/media_queue';
import { sourceEndOf } from '../lib/editor/playback-rate';

/**
 * Processed copies of a clip's source, made by the media worker: a freeze-frame still (free), smooth slow
 * motion by fal.ai RIFE frame interpolation, or a fal.ai upscale. Video copies keep the source's timeline
 * (black padding before `start`), so a clip switches to one by changing only its media.
 */
const op = v.union(v.literal('freeze'), v.literal('slowmo'), v.literal('upscale'), v.literal('stats'), v.literal('parallax'), v.literal('pixelTrack'));
export type DerivationOp = Doc<'derivations'>['op'];
export const MAX_SLOWMO_SECONDS = 30, MAX_UPSCALE_SECONDS = 60, MAX_SLOWMO_FACTOR = 8;
const HANDLE_SECONDS = .25, PLACEMENT_DELAY_MS = 10_000, PLACEMENT_ATTEMPTS = 360;
// fal.ai (Oct 2026): video upscaler $0.0008 per output megapixel; RIFE $0.0013 per compute second (about 1.5 s per output second).
const UPSCALE_USD_PER_MEGAPIXEL = .0008, RIFE_USD_PER_OUTPUT_SECOND = .002;

type StartInput = { ownerId: string; projectId: Id<'projects'>; clipId: string; assetId: string; op: DerivationOp; selection?: Pick<PixelTrackRequest, 'time' | 'seed' | 'segmenter'>; tracking?: PixelTrackRequest; start: number; end: number; backgroundPrompt?: string; time?: number; times?: number[]; factor?: number; scale?: number; target?: number; fps?: number; placeLater: boolean };

/** Queue (or reuse) a processed copy. Window times are source seconds. */
export async function startDerivation(ctx: MutationCtx, input: StartInput) {
  await requireEditorAccess(ctx, input.ownerId);
  const project = await readProject(ctx, input.projectId);
  if (!project || project.ownerId !== input.ownerId || project.deleting) throw new ConvexError('Project not found.');
  const id = ctx.db.normalizeId('assets', input.assetId), asset = id ? await ctx.db.get(id) : null;
  if (!asset || asset.ownerId !== input.ownerId || asset.projectId !== project._id) throw new ConvexError('This clip’s media is unavailable.');
  if ((input.op === 'slowmo' || input.op === 'upscale') && asset.derivedOf && asset.derivation !== 'freeze') throw new ConvexError(`This clip already uses ${asset.derivation === 'slowmo' ? 'smooth slow-motion' : asset.derivation === 'upscale' ? 'upscaled' : 'processed (Genesis)'} footage. Process the original instead.`);
  if (input.op === 'parallax' && asset.kind === 'audio') throw new ConvexError('Parallax needs a video or image.');
  if (input.op === 'parallax' && input.placeLater) throw new ConvexError('Parallax atlases must be placed with their renderer.');
  if (input.op === 'freeze' && asset.kind !== 'video') throw new ConvexError('Freeze a video clip.');
  if (input.op === 'pixelTrack') {
    if (asset.kind !== 'video') throw new ConvexError('Pixel tracking needs video footage.');
    const tracking = pixelTrackRequest.parse(input.tracking);
    if (tracking.end > (asset.duration ?? 0) + 1e-6) throw new ConvexError('Track inside the source duration.');
    await requireMediaTaskCapacity(ctx, input.ownerId, 1);
    const derivationId = await ctx.db.insert('derivations', { ownerId: input.ownerId, projectId: project._id, clipId: input.clipId, sourceAssetId: asset._id, op: 'pixelTrack', start: tracking.start, end: tracking.end, tracking, trackingToken: crypto.randomUUID(), status: 'queued', createdAt: Date.now() });
    await ctx.db.patch(derivationId, { taskId: await enqueueMediaTask(ctx, { ownerId: input.ownerId, projectId: project._id, assetId: asset._id, kind: 'derive', derivationId, requiredProcessorVersion: MEDIA_PROCESSOR_VERSION }) });
    return { derivationId, status: 'queued' as const, estimatedUsd: 0 };
  }
  if (input.op === 'stats') {
    if (asset.kind === 'audio') throw new ConvexError('Measure color on a video or image clip.');
    if (!input.times?.length || input.times.length > 6) throw new ConvexError('Measure 1 to 6 moments.');
    await requireMediaTaskCapacity(ctx, input.ownerId, 1);
    const derivationId = await ctx.db.insert('derivations', { ownerId: input.ownerId, projectId: project._id, clipId: input.clipId, sourceAssetId: asset._id, op: 'stats', start: input.times[0], end: input.times[input.times.length - 1], times: input.times, status: 'queued', createdAt: Date.now() });
    await ctx.db.patch(derivationId, { taskId: await enqueueMediaTask(ctx, { ownerId: input.ownerId, projectId: project._id, assetId: asset._id, kind: 'derive', derivationId }) });
    return { derivationId, status: 'queued' as const, estimatedUsd: 0 };
  }
  if (input.op === 'slowmo' && (asset.kind !== 'video' || asset.cutoutOf)) throw new ConvexError('Smooth slow motion needs original video footage, not a cut-out.');
  if (input.op === 'upscale' && (asset.kind === 'audio' || asset.cutoutOf)) throw new ConvexError('Upscale a video or image clip (not a cut-out).');
  if(input.selection){
    input.selection=subjectSelection.parse(input.selection);
    if(input.selection.time!==(input.time??input.start))throw new ConvexError('Select the subject on the freeze frame.');
  }
  const duration = asset.duration ?? 0;
  let start = input.start, end = input.end;
  if (asset.kind === 'video') {
    if (!(duration > 0)) throw new ConvexError('This video has no recorded length.');
    start = Math.max(0, start - (input.op === 'freeze' || input.op === 'parallax' ? 0 : HANDLE_SECONDS)); end = Math.min(duration, end + (input.op === 'freeze' || input.op === 'parallax' ? 0 : HANDLE_SECONDS));
    if (!(end >= start)) throw new ConvexError('Choose footage inside the clip.');
  }
  const limit = input.op === 'slowmo' ? MAX_SLOWMO_SECONDS : MAX_UPSCALE_SECONDS;
  if (input.op !== 'freeze' && end - start > limit) throw new ConvexError(`Process up to ${limit} seconds at a time. Split or trim this clip first.`);
  const same = (row: Doc<'derivations'>) => row.op === input.op && row.sourceAssetId === asset._id && (input.op === 'freeze' || input.op === 'parallax' ? subjectSelectionKey(row.selection) === subjectSelectionKey(input.selection) && row.backgroundPrompt === input.backgroundPrompt && Math.abs((row.time ?? -1) - (input.time ?? 0)) < 1e-3
    : row.start <= start + 1e-6 && row.end >= end - 1e-6 && (row.factor ?? 1) >= (input.factor ?? 1) && row.target === input.target);
  const rows = await ctx.db.query('derivations').withIndex('by_source_op', q => q.eq('sourceAssetId', asset._id).eq('op', input.op)).order('desc').take(30);
  for (const row of rows) {
    if (!same(row) || row.ownerId !== input.ownerId || row.status === 'failed') continue;
    if (row.status === 'queued') return { derivationId: row._id, status: 'queued' as const, estimatedUsd: 0 };
    const output = row.outputAssetId ? await ctx.db.get(row.outputAssetId) : null;
    if (output && output.projectId === project._id) return { derivationId: row._id, status: 'completed' as const, outputAssetId: output._id, estimatedUsd: 0 };
  }
  await requireMediaTaskCapacity(ctx, input.ownerId, 1);
  const derivationId = await ctx.db.insert('derivations', { ownerId: input.ownerId, projectId: project._id, clipId: input.clipId, sourceAssetId: asset._id, op: input.op, start, end,
    ...(input.selection ? { selection: input.selection } : {}), ...(input.backgroundPrompt !== undefined ? { backgroundPrompt: input.backgroundPrompt } : {}), ...(input.time !== undefined ? { time: input.time } : {}), ...(input.factor ? { factor: input.factor } : {}), ...(input.scale ? { scale: input.scale } : {}), ...(input.target ? { target: input.target } : {}),
    ...(input.placeLater ? { placeLater: true } : {}), status: 'queued', createdAt: Date.now() });
  const taskId = await enqueueMediaTask(ctx, { ownerId: input.ownerId, projectId: project._id, assetId: asset._id, kind: 'derive', derivationId, ...(input.op === 'parallax' ? { requiredProcessorVersion: MEDIA_PROCESSOR_VERSION } : {}) });
  await ctx.db.patch(derivationId, { taskId });
  const seconds = end - start, fps = input.fps ?? 30;
  const estimatedUsd = input.op === 'parallax' ? .08 : input.op === 'freeze' ? 0 : input.op === 'slowmo' ? seconds * (input.factor ?? 2) * RIFE_USD_PER_OUTPUT_SECOND
    : (asset.kind === 'image' ? 1 : seconds * fps) * (asset.width ?? 1920) * (asset.height ?? 1080) * (input.scale ?? 2) ** 2 / 1e6 * UPSCALE_USD_PER_MEGAPIXEL;
  return { derivationId, status: 'queued' as const, estimatedUsd: Math.max(input.op === 'freeze' ? 0 : .01, Math.round(estimatedUsd * 100) / 100) };
}

async function requireRun(ctx: MutationCtx | import('./_generated/server').QueryCtx, args: { projectId: Id<'projects'>; ownerId: string; runId: string }) {
  const project = await readProject(ctx, args.projectId);
  if (!project || project.ownerId !== args.ownerId || project.aiRunId !== args.runId || !project.aiRunning) throw new ConvexError('AI run is no longer active');
}

export const startFromRun = internalMutation({
  args: { ...runArgs, clipId: v.string(), assetId: v.string(), op, tracking: v.optional(pixelTrackRequestValidator), start: v.number(), end: v.number(), selection: v.optional(subjectSelectionValidator), backgroundPrompt: v.optional(v.string()), time: v.optional(v.number()), times: v.optional(v.array(v.number())), factor: v.optional(v.number()), scale: v.optional(v.number()), target: v.optional(v.number()), fps: v.optional(v.number()), placeLater: v.boolean() },
  returns: v.object({ derivationId: v.id('derivations'), status: v.union(v.literal('queued'), v.literal('completed')), outputAssetId: v.optional(v.id('assets')), estimatedUsd: v.number() }),
  handler: async (ctx, { runId, ...args }) => {
    await requireRun(ctx, { ...args, runId });
    // SAM 3.1 (Meta) is for MCP clients only; Revline's in-app agent keeps fal SAM2 / Florence-2.
    const mcp = isMcpRun(runId);
    return startDerivation(ctx, { ...args, ...(args.selection ? { selection: forSurface(args.selection, mcp) } : {}), ...(args.tracking ? { tracking: forSurface(args.tracking, mcp && args.tracking.seed.kind === 'object') } : {}) });
  },
});

export const runStatus = internalQuery({
  args: { ...runArgs, derivationId: v.string() },
  returns: v.object({ status: v.union(v.literal('queued'), v.literal('completed'), v.literal('failed')), outputAssetId: v.optional(v.id('assets')), stats: v.optional(v.array(v.any())), pixelTrack: v.optional(pixelTrackResultValidator), sourceAssetId: v.id('assets'), error: v.optional(v.string()), progress: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId('derivations', args.derivationId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.ownerId !== args.ownerId || row.projectId !== args.projectId) throw new ConvexError('Processing request not found.');
    const task = row.status === 'queued' && row.taskId ? await ctx.db.get(row.taskId) : null;
    return { status: row.status, sourceAssetId: row.sourceAssetId, ...(row.pixelTrack ? { pixelTrack: row.pixelTrack } : {}), ...(row.outputAssetId ? { outputAssetId: row.outputAssetId } : {}), ...(row.stats ? { stats: row.stats } : {}), ...(row.error ? { error: row.error } : {}), ...(task ? { progress: task.progress } : {}) };
  },
});

/** The worker stored the copy: record its provenance, then switch the clip when it was queued to place itself. */
export async function completeDerivation(ctx: MutationCtx, task: Doc<'mediaTasks'>, colorStats?: unknown[], pixelTrack?: PixelTrackResult) {
  const row = task.derivationId ? await ctx.db.get(task.derivationId) : null;
  if (row?.op === 'pixelTrack') {
    if (row.status !== 'queued' || !row.tracking || !pixelTrack) throw new ConvexError('Pixel tracking returned no result.');
    const result = parsePixelTrackResult(pixelTrack, row.tracking);
    if (result.engine === 'opencv-klt-template-v2' && (row.trackingAttempt !== task.attempt || row.trackingCount !== result.sampleCount)) throw new ConvexError('Track chunks do not match the completion receipt.');
    await ctx.db.patch(row._id, { status: 'completed', pixelTrack: result });
    return;
  }
  if (row?.op === 'stats') {
    if (row.status !== 'queued' || !colorStats?.length || colorStats.length > 6 || JSON.stringify(colorStats).length > 20_000) throw new ConvexError('Color measurement returned no usable result.');
    await ctx.db.patch(row._id, { status: 'completed', stats: colorStats });
    return;
  }
  const output = task.outputAssetId ? await ctx.db.get(task.outputAssetId) : null;
  if (!row || row.status !== 'queued') throw new ConvexError('The processing request is no longer active.');
  if (!output || output.ownerId !== task.ownerId || output.projectId !== task.projectId) throw new ConvexError('The processed media has not been stored yet.');
  const source = await ctx.db.get(row.sourceAssetId);
  // Video copies are picture only on the source's timeline: they share its extracted sound.
  await ctx.db.patch(output._id, { derivedOf: row.sourceAssetId, derivation: row.op, ...(output.kind === 'video' ? { derivedStart: row.start, audioExtracted: true, ...(source?.audioAssetId ? { audioAssetId: source.audioAssetId } : {}) } : {}) });
  await ctx.db.patch(row._id, { status: 'completed', outputAssetId: output._id });
  if (row.placeLater) await placeDerivation(ctx, { ...row, status: 'completed', outputAssetId: output._id }, output);
}

/** Switch the clip to the processed copy when it still shows the processed source range. */
export async function placeDerivation(ctx: MutationCtx, row: Doc<'derivations'>, output: Doc<'assets'>, attempt = 0): Promise<void> {
  const project = await readProject(ctx, row.projectId);
  if (!project || project.deleting || project.ownerId !== row.ownerId) return;
  if (await editingWorkflowActive(ctx, project)) {
    if (attempt < PLACEMENT_ATTEMPTS) await ctx.scheduler.runAfter(PLACEMENT_DELAY_MS, internal.derivations.placeLater, { derivationId: row._id, attempt: attempt + 1 });
    return;
  }
  const timeline = currentTimeline(project), clip = timeline.clips.find(item => item.id === row.clipId);
  const fits = !!clip && clip.assetId === row.sourceAssetId && (output.kind === 'image'
    || clip.sourceStart >= row.start - 1e-6 && sourceEndOf(clip) <= Math.min(row.end, output.duration ?? 0) + 1 / timeline.fps);
  if (fits) await commitTimeline(ctx, project, { ...timeline, clips: timeline.clips.map(item => item.id === clip.id ? { ...item, assetId: output._id } : item) }, project.revision ?? 0);
  await ctx.db.patch(row._id, { placed: fits });
}

export const placeLater = internalMutation({ args: { derivationId: v.id('derivations'), attempt: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.derivationId), output = row?.outputAssetId ? await ctx.db.get(row.outputAssetId) : null;
  if (row?.status === 'completed' && output && row.placed === undefined) await placeDerivation(ctx, row, output, args.attempt);
  return null;
}});
