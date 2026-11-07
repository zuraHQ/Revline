import { z } from 'zod';
import { hexColor } from './layer';

const unit = z.number().min(0).max(1);
/** Where focus sits: a depth value (0 = nearest, 1 = farthest), a frame point whose depth is read every frame, or a SAM layer's subject. */
export const focusTarget = z.union([
  z.object({ depth: unit }).strict(),
  z.object({ point: z.object({ x: unit, y: unit }).strict() }).strict(),
  z.object({ layerId: z.string().min(1) }).strict(),
]);
export type FocusTarget = z.infer<typeof focusTarget>;

export const depthInput = z.object({
  clipId: z.string().min(1).describe('Footage clip; the pass covers its source range.'),
}).strict();
export const depthDescription = "Genesis (MCP only). One depth pass of a footage clip with Video Depth Anything (VDA-Small, Apache-2.0) on fal: a temporally stable grayscale depth video on the source clock (white = near), stored and reused by every depth effect and by subject relight, like a SAM layer. Up to 60 s. $0.04 per second. Background: returns jobId at once; poll getJob until ready (measured: 8 s of 1080p took about a minute). The same clip range reuses the existing pass for free.";

export const depthEffectInput = z.object({
  clipId: z.string().min(1).describe('Footage clip to change. It may already show a Genesis result (e.g. a relight) of the same source.'),
  depthId: z.string().min(1).describe('jobId of a ready depth pass of this footage.'),
  effect: z.enum(['portraitBlur', 'focusPull', 'fog', 'depthScan']),
  focus: focusTarget.optional().describe('portraitBlur: what stays sharp. Default {depth:0} (the nearest things).'),
  from: focusTarget.optional().describe('focusPull: focus at the start of the pull.'),
  to: focusTarget.optional().describe('focusPull: focus at the end of the pull.'),
  start: z.number().min(0).optional().describe('focusPull/depthScan: TIMELINE second the pull or sweep starts; default the clip start.'),
  end: z.number().positive().optional().describe('focusPull/depthScan: TIMELINE second it ends; default the clip end.'),
  amount: unit.optional().describe('portraitBlur/focusPull: blur strength (default .5 = 24 px at 1080p at the farthest point). fog: density (default .5). depthScan: line brightness (default .8).'),
  color: z.string().regex(hexColor).optional().describe('fog colour (default #C8CDD2) or depthScan line colour (default #7FE8FF).'),
  near: unit.optional().describe('fog: depth where the fog begins (default .15).'),
  width: z.number().min(.01).max(.5).optional().describe('depthScan: line thickness in depth units (default .04).'),
  direction: z.enum(['frontToBack', 'backToFront']).optional().describe('depthScan direction (default frontToBack).'),
  keepLayerId: z.string().min(1).optional().describe('A ready SAM layer whose subject stays untouched (e.g. blur or fog everything except the woman).'),
}).strict();
export type DepthEffectInput = z.infer<typeof depthEffectInput>;

export const depthEffectDescription = "Genesis (MCP only). A depth effect on footage, from a ready depth pass (depthId) plus optional SAM layers. portraitBlur: blur grows with distance from a focus depth (focus: {depth} | {point:{x,y}} | {layerId}). focusPull: focus moves from `from` to `to` between start and end (e.g. from the woman's layer to the gardener's). fog: haze whose density grows with distance (amount, color, near). depthScan: a glowing line sweeps through the scene front to back (or back to front) between start and end (color, width, amount, direction). keepLayerId keeps a subject untouched. Our own compositor on the media worker: no fal cost, no generation. The result is a new 1080p video asset; poll getJob, then applyJob points the clip at it (one undo restores). For a fake camera move use freezeFrameParallax instead.";

/** The compositor's controls for an effect, in source seconds. Missing focus targets fall back to sensible defaults. */
export function effectParams(input: DepthEffectInput, toSource: (time: number) => number, clipRange: { start: number; end: number }) {
  const from = input.start !== undefined ? toSource(input.start) : clipRange.start, to = input.end !== undefined ? toSource(input.end) : clipRange.end;
  if (to - from <= 0) throw new Error('end must be after start.');
  const base = { effect: input.effect, ...(input.keepLayerId ? { keepLayerId: input.keepLayerId } : {}) };
  switch (input.effect) {
    case 'portraitBlur':
      if (input.from || input.to) throw new Error('portraitBlur takes focus; use focusPull for from/to.');
      return { ...base, focus: input.focus ?? { depth: 0 }, amount: input.amount ?? .5 };
    case 'focusPull':
      if (!input.from || !input.to) throw new Error('focusPull needs from and to (each {depth}, {point} or {layerId}).');
      return { ...base, from: input.from, to: input.to, amount: input.amount ?? .5, t0: from, t1: to };
    case 'fog':
      return { ...base, amount: input.amount ?? .5, color: input.color ?? '#C8CDD2', near: input.near ?? .15 };
    case 'depthScan':
      return { ...base, amount: input.amount ?? .8, color: input.color ?? '#7FE8FF', width: input.width ?? .04, direction: input.direction ?? 'frontToBack', t0: from, t1: to };
  }
}
export type EffectParams = ReturnType<typeof effectParams>;

/** Every SAM layer an effect reads: the kept subject and any focus subjects. */
export function effectLayers(params: EffectParams): string[] {
  const ids = new Set<string>();
  if ('keepLayerId' in params && params.keepLayerId) ids.add(params.keepLayerId);
  for (const target of [('focus' in params ? params.focus : undefined), ('from' in params ? params.from : undefined), ('to' in params ? params.to : undefined)])
    if (target && 'layerId' in target) ids.add(target.layerId);
  return [...ids];
}

export const getJobInput = z.object({ jobId: z.string().min(1) }).strict();
export const getJobDescription = "Genesis (MCP only). Read a Genesis job (depth pass, relight or depth effect): status processing | ready | failed (with the worker error), progress, source range, model and mode, estimatedUsd while processing or the real costUsd once ready, latency, and where it was applied. Poll every 15-30 s after depth, relight or depthEffect.";
export const applyJobInput = z.object({
  jobId: z.string().min(1),
  clipId: z.string().min(1).optional().describe('Clip to point at the result; default the clip the job was made from.'),
}).strict();
export const applyJobDescription = "Genesis (MCP only). Point a footage clip at a ready relight or depth-effect result: only the clip's media changes (timing, sound, framing and effects stay), saved as one edit, so one undoLatestEdit restores the original. The clip must still play the job's source range. Then getFrames at full resolution and finish.";
