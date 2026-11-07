import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { runArgs, holdsRun } from './lib/active_run';
import { isMcpRun } from './lib/run_ids';
import { readProject } from './lib/project_data';
import { requireEditorAccess } from './lib/billing_access';
import { requireMediaTaskCapacity } from './lib/account_limits';
import { enqueueMediaTask } from './lib/media_queue';
import { pixelTrackRequestValidator } from './lib/pixel_track_validator';
import { MEDIA_PROCESSOR_VERSION } from '../lib/media-analysis/processor-version';
import { sam31Usd, subjectSelection, subjectSelectionKey } from '../lib/media-analysis/pixel-track';
import type { GenesisLayerEvidence } from '../lib/ai/lanes/types';
import { MAX_LAYER_BOXES } from '../lib/ai/lanes/genesis/functions/segment';

/** Genesis (MCP only): one SAM 3.1 subject layer, made by a foreground cut-out that is never placed itself. */
const HANDLE_SECONDS = .25, MAX_SECONDS = 120;
const box = v.array(v.number());
const application = v.object({ timelineId: v.string(), function: v.string(), baseClipId: v.string(), clipIds: v.array(v.string()), subjectClipIds: v.array(v.string()) });
export const layerStatus = (cutout: Doc<'cutouts'> | null) => !cutout || cutout.status === 'failed' ? 'failed' as const : cutout.status === 'completed' && cutout.outputAssetId ? 'ready' as const : 'processing' as const;
// Upper bound before the worker reads the source rate: it never sends more frames than the timeline plays.
const usd = (seconds: number, fps: number, noun: boolean) => sam31Usd(Math.ceil(seconds * fps), noun);

export async function requireMcpRun(ctx: QueryCtx | MutationCtx, args: { projectId: Id<'projects'>; ownerId: string; runId: string }, exclusive: boolean) {
  if (!isMcpRun(args.runId)) throw new ConvexError('Genesis is available to MCP clients only.');
  const project = await readProject(ctx, args.projectId);
  if (!project || project.ownerId !== args.ownerId || exclusive && !holdsRun(project, args.runId)) throw new ConvexError('AI run is no longer active');
  return project;
}
export async function ownedLayer(ctx: QueryCtx | MutationCtx, args: { projectId: Id<'projects'>; ownerId: string }, layerId: string) {
  const id = ctx.db.normalizeId('genesisLayers', layerId), layer = id ? await ctx.db.get(id) : null;
  if (!layer || layer.ownerId !== args.ownerId || layer.projectId !== args.projectId) throw new ConvexError('Layer not found in this project. Use the layerId segment returned.');
  return layer;
}

export const startFromRun = internalMutation({
  args: { ...runArgs, clipId: v.string(), sourceAssetId: v.string(), prompt: v.string(), time: v.number(), seed: pixelTrackRequestValidator.fields.seed, start: v.number(), end: v.number(), fps: v.number() },
  returns: v.object({ layerId: v.id('genesisLayers'), status: v.union(v.literal('processing'), v.literal('ready')), estimatedUsd: v.number(), reused: v.boolean() }),
  handler: async (ctx, args) => {
    const project = await requireMcpRun(ctx, args, true);
    await requireEditorAccess(ctx, args.ownerId);
    const assetId = ctx.db.normalizeId('assets', args.sourceAssetId), shown = assetId ? await ctx.db.get(assetId) : null;
    // A clip showing a Genesis relight or depth effect is segmented on its original footage (same source clock).
    const asset = shown?.derivedOf && !shown.derivation ? await ctx.db.get(shown.derivedOf) : shown;
    if (!asset || asset.ownerId !== args.ownerId || asset.projectId !== project._id || asset.kind !== 'video' || !asset.duration) throw new ConvexError('This clip’s video is unavailable.');
    if (asset.cutoutOf) throw new ConvexError('This clip already shows a cut-out. Segment the original footage.');
    let selection;
    try { selection = subjectSelection.parse({ time: args.time, seed: args.seed, segmenter: 'sam-3.1' }); } catch { throw new ConvexError('Choose a normalized source point/box or a noun.'); }
    // A short handle on each side keeps later one-frame trims inside the mask.
    const start = Math.max(0, args.start - HANDLE_SECONDS), end = Math.min(asset.duration, args.end + HANDLE_SECONDS);
    if (!(end > start) || selection.time < start || selection.time >= end) throw new ConvexError('The prompt frame must be inside the masked range.');
    if (end - start > MAX_SECONDS) throw new ConvexError(`Segment up to ${MAX_SECONDS} seconds at a time. Pass start/end or split the clip.`);
    const key = subjectSelectionKey(selection);
    for (const layer of await ctx.db.query('genesisLayers').withIndex('by_project', q => q.eq('projectId', project._id)).order('desc').take(50)) {
      if (layer.ownerId !== args.ownerId || layer.sourceAssetId !== asset._id || subjectSelectionKey(layer.selection) !== key || layer.start > args.start + 1e-6 || layer.end < Math.min(args.end, asset.duration) - 1e-6) continue;
      const status = layerStatus(await ctx.db.get(layer.cutoutId));
      if (status !== 'failed') return { layerId: layer._id, status, estimatedUsd: 0, reused: true };
    }
    await requireMediaTaskCapacity(ctx, args.ownerId, 1);
    const fps = Math.max(1, Math.min(60, Math.round(args.fps)));
    const cutoutId = await ctx.db.insert('cutouts', { ownerId: args.ownerId, projectId: project._id, clipId: args.clipId, sourceAssetId: asset._id, start, end, fps, mode: 'foreground', selection, status: 'queued', createdAt: Date.now(), purpose: 'genesis' });
    // Per-frame boxes measured from the mask come from the v53 processor; older workers cannot claim the task.
    const taskId = await enqueueMediaTask(ctx, { ownerId: args.ownerId, projectId: project._id, assetId: asset._id, kind: 'cutout', cutoutId, requiredProcessorVersion: MEDIA_PROCESSOR_VERSION });
    await ctx.db.patch(cutoutId, { taskId });
    const estimatedUsd = usd(end - start, fps, args.seed.kind === 'object');
    const layerId = await ctx.db.insert('genesisLayers', { ownerId: args.ownerId, projectId: project._id, clipId: args.clipId, sourceAssetId: asset._id, cutoutId, prompt: args.prompt.slice(0, 200), selection, start, end, fps, model: 'sam-3.1', estimatedUsd, applications: [], createdAt: Date.now() });
    return { layerId, status: 'processing' as const, estimatedUsd, reused: false };
  },
});

/** Status, coverage and the per-frame boxes of a source range (one page of at most MAX_LAYER_BOXES frames). */
export const layerForRun = internalQuery({
  args: { ...runArgs, layerId: v.string(), from: v.optional(v.number()), to: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, false);
    const layer = await ownedLayer(ctx, args, args.layerId), cutout = await ctx.db.get(layer.cutoutId);
    const status = layerStatus(cutout), task = status === 'processing' && cutout?.taskId ? await ctx.db.get(cutout.taskId) : null;
    const boxes = layer.boxes ?? [], visible = boxes.flatMap((item, index) => item ? [index] : []);
    // Frame k of the mask shows source second start + k / fps (the cut-out is on the source clock).
    const at = (index: number) => Math.round((layer.start + index / layer.fps) * 1e6) / 1e6;
    const first = Math.max(0, args.from === undefined ? 0 : Math.ceil((args.from - layer.start) * layer.fps - 1e-6));
    const last = Math.min(boxes.length - 1, args.to === undefined ? boxes.length - 1 : Math.floor((args.to - layer.start) * layer.fps + 1e-6), first + MAX_LAYER_BOXES - 1);
    const page = status === 'ready' && boxes.length ? {
      boxes: first <= last
        ? { from: at(first), fps: layer.fps, frames: last - first + 1, boxes: boxes.slice(first, last + 1), ...(last < boxes.length - 1 && (args.to === undefined || at(last + 1) <= args.to + 1e-6) ? { next: at(last + 1) } : {}) }
        : { from: at(first), fps: layer.fps, frames: 0, boxes: [], note: `No mask frame in that range. The layer covers source ${at(0)}–${at(boxes.length - 1)}s.` },
    } : {};
    return {
      layerId: layer._id, status, ...(status === 'failed' ? { error: cutout?.error ?? 'The layer job is gone. Segment again.' } : {}), ...(task ? { progress: task.progress ?? 0 } : {}),
      clipId: layer.clipId, sourceAssetId: layer.sourceAssetId, prompt: layer.prompt, source: { start: layer.start, end: layer.end }, fps: layer.fps,
      model: layer.model, provider: 'Meta Model API', ...(layer.readyAt ? { costUsd: layer.estimatedUsd } : { estimatedUsd: layer.estimatedUsd }),
      ...(layer.readyAt ? { latencySeconds: Math.round((layer.readyAt - layer.createdAt) / 100) / 10 } : {}),
      ...(status === 'ready' ? { maskAssetId: cutout!.outputAssetId, coverage: { frames: boxes.length, visibleFrames: visible.length, ...(visible.length ? { firstVisible: at(visible[0]), lastVisible: at(visible[visible.length - 1]) } : {}) }, ...page } : {}),
      applications: layer.applications,
      next: status === 'ready' ? 'Apply layerEffect or textBehind with this layerId, then getFrames. To follow the subject on the timeline, a box at SOURCE second s shows at timeline second clip.start + (s - clip.sourceStart) / playbackRate of the footage clip (footage without a speed ramp).' : status === 'processing' ? 'Call getLayer again in 10-15 seconds.' : 'Segment again, ideally with a box on a frame where the subject is clear.',
    };
  },
});

/** A ready layer for a layer function, or a clear refusal while it is processing or failed. */
export const readyForRun = internalQuery({
  args: { ...runArgs, layerId: v.string() },
  returns: v.object({ layerId: v.string(), clipId: v.string(), sourceAssetId: v.string(), outputAssetId: v.string(), start: v.number(), end: v.number(), fps: v.number() }),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, false);
    const layer = await ownedLayer(ctx, args, args.layerId), cutout = await ctx.db.get(layer.cutoutId), status = layerStatus(cutout);
    if (status === 'processing') throw new ConvexError(`Layer ${layer._id} is still processing. Poll getLayer until ready.`);
    if (status === 'failed') throw new ConvexError(`Layer ${layer._id} failed: ${cutout?.error ?? 'its job is gone'}. Segment again.`);
    return { layerId: layer._id, clipId: layer.clipId, sourceAssetId: layer.sourceAssetId, outputAssetId: cutout!.outputAssetId!, start: layer.start, end: layer.end, fps: layer.fps };
  },
});

/** Genesis clips earlier functions stacked on one footage clip of one timeline, across every layer. */
export const stackForRun = internalQuery({
  args: { ...runArgs, timelineId: v.string(), baseClipId: v.string() },
  returns: v.object({ clipIds: v.array(v.string()), subjectClipIds: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, false);
    const uses = (await ctx.db.query('genesisLayers').withIndex('by_project', q => q.eq('projectId', args.projectId)).order('desc').take(100))
      .filter(layer => layer.ownerId === args.ownerId).flatMap(layer => layer.applications).filter(use => use.timelineId === args.timelineId && use.baseClipId === args.baseClipId);
    return { clipIds: [...new Set(uses.flatMap(use => use.clipIds))], subjectClipIds: [...new Set(uses.flatMap(use => use.subjectClipIds))] };
  },
});

export const recordApplication = internalMutation({
  args: { ...runArgs, layerId: v.string(), application },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireMcpRun(ctx, args, true);
    const layer = await ownedLayer(ctx, args, args.layerId);
    // Most recent 50 applications are enough for any timeline's checks.
    await ctx.db.patch(layer._id, { applications: [...layer.applications, { ...args.application, at: Date.now() }].slice(-50) });
    return null;
  },
});

/** Layers that were placed or whose cut-out the checked timelines use, for the Genesis finish checks.
 * Boxes (up to thousands per layer) are returned only for layers in use. */
export const forCheck = internalQuery({
  args: { ownerId: v.string(), projectId: v.id('projects'), usedAssetIds: v.array(v.string()) },
  returns: v.array(v.object({ layerId: v.string(), status: v.union(v.literal('processing'), v.literal('ready'), v.literal('failed')), outputAssetId: v.optional(v.string()), sourceAssetId: v.string(), start: v.number(), end: v.number(), fps: v.number(), boxes: v.optional(v.array(v.union(v.null(), box))), applications: v.array(application) })),
  handler: async (ctx, args): Promise<GenesisLayerEvidence[]> => {
    const used = new Set(args.usedAssetIds);
    const layers = (await ctx.db.query('genesisLayers').withIndex('by_project', q => q.eq('projectId', args.projectId)).order('desc').take(100)).filter(layer => layer.ownerId === args.ownerId);
    const rows = await Promise.all(layers.map(async layer => ({ layer, cutout: await ctx.db.get(layer.cutoutId) })));
    // Functions place a layer, but its cut-out can also be added as a clip or scene media.
    return rows.filter(({ layer, cutout }) => layer.applications.length || cutout?.outputAssetId && used.has(cutout.outputAssetId)).map(({ layer, cutout }) => {
      const inUse = !!cutout?.outputAssetId && used.has(cutout.outputAssetId);
      return { layerId: layer._id, status: layerStatus(cutout), ...(cutout?.outputAssetId ? { outputAssetId: cutout.outputAssetId } : {}), sourceAssetId: layer.sourceAssetId, start: layer.start, end: layer.end, fps: layer.fps, ...(layer.boxes && inUse ? { boxes: layer.boxes } : {}), applications: layer.applications.map(({ at: _at, ...use }) => use) };
    });
  },
});

/** The worker finished a Genesis cut-out: keep the mask and boxes on the layer; never place the cut-out itself. */
export async function completeGenesisCutout(ctx: MutationCtx, cutout: Doc<'cutouts'>, mask: { fps: number; boxes: (number[] | null)[] } | undefined) {
  const layer = await ctx.db.query('genesisLayers').withIndex('by_cutout', q => q.eq('cutoutId', cutout._id)).unique();
  if (!layer) return;
  if (!mask) throw new ConvexError('The SAM 3.1 layer finished without per-frame boxes.');
  if (!mask.boxes.length || mask.boxes.some(item => item && (item.length !== 4 || item.some(value => !Number.isFinite(value) || value < 0 || value > 1)))) throw new ConvexError('The SAM 3.1 boxes are malformed.');
  // The cost of the frames SAM 3.1 actually processed replaces the estimate.
  await ctx.db.patch(layer._id, { fps: mask.fps, boxes: mask.boxes, estimatedUsd: sam31Usd(mask.boxes.length, layer.selection.seed.kind === 'object'), readyAt: Date.now() });
}
