/** Genesis's own functions: one SAM 3.1 layer and one depth pass, each reused by every function that needs it. MCP callers only. */
export const ownTools = ['segment', 'getLayer', 'layerEffect', 'textBehind', 'depth', 'depthEffect', 'relight', 'getJob', 'applyJob'] as const;
// Supporting tools Genesis reuses instead of re-inventing: frame reads, point tracking, masks and looks.
export const tools = [
  ...ownTools,
  'readFrames',
  'inspectFrames',
  'trackPoints',
  'getTrack',
  'attachToTrack',
  'setMask',
  'setVisualEffects',
  'addTransition',
] as const;
