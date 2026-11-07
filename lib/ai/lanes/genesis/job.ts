import { v, type Infer } from 'convex/values';

/** Genesis media jobs (MCP only): one VDA-Small depth pass, a LightX relight, or a depth effect.
 * The worker receives this work and returns `genesisJobResult`. Convex and the worker both import this leaf module. */
export const genesisJobKind = v.union(v.literal('depth'), v.literal('relight'), v.literal('effect'));
export type GenesisJobKind = Infer<typeof genesisJobKind>;

export const genesisWork = v.object({
  job: genesisJobKind,
  /** Source seconds of the processed range; the output video is on the source clock (black before `start`). */
  start: v.number(),
  end: v.number(),
  /** relight: { plan, scope, falloff, seed }. effect: { effect, ...controls }. Validated by the worker. */
  params: v.any(),
  /** SAM 3.1 layers' transparent cut-outs on the source clock, by layerId (subject relight, kept subjects, focus subjects). */
  masks: v.optional(v.array(v.object({ layerId: v.string(), url: v.string() }))),
  /** The depth pass on the source clock: grayscale, white = near. */
  depthUrl: v.optional(v.string()),
});
export type GenesisWork = Infer<typeof genesisWork>;

export const genesisJobResult = v.object({
  /** Seconds fal bills for: LightX output seconds, or Depth Anything input seconds. 0 for our own compositor. */
  billedSeconds: v.number(),
  /** relight: the LightX mode that ran (ic | hdr); others omit it. */
  mode: v.optional(v.string()),
  /** Calls made to fal (relight windows), for the cost note. */
  calls: v.optional(v.number()),
});
export type GenesisJobResult = Infer<typeof genesisJobResult>;

export type RelightParams = {
  plan: import('./functions/light').LightPlan;
  scope: 'frame' | 'subject';
  /** subject scope: the SAM layer that is relit. */
  layerId?: string;
  /** 0..1: blend toward the original (1 = LightX's full light change). */
  strength: number;
  /** 0..1: how far the subject's new light spills into the nearby scene, by depth and distance. */
  falloff: number;
  seed: number;
};
