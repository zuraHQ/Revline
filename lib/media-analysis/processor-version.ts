/** The media-task contract this code implements. Workers send it when claiming
 * work, the edge controller reports it, and Convex returns it as the release
 * contract; tasks needing newer features set requiredProcessorVersion. */
// 36: persistent frame and analysis caching.
// 32: shared scene bundles. 33: keyframed reference crops. 34: uncapped scene media. 35: still-image reads/comparisons.
// 37: local runtime capabilities, resilient remote inputs and shared source reads.
// 38: cached Gemini highlight discovery and clip delivery checks.
// 39: full-resolution reference elements, calibrated opacity, shared joint timing/ease fitter.
// 40: integrated highlight/clip checks with the reference motion runtime.
// 41: lossless chunked transcript transport across worker and agent RPC boundaries.
// 42: keep tracked crop keyframes on the extracted review/render source clock.
// 43: explicit 1080p inspection must never be handled as a 720p preview.
// 44: decode bound scene video before the final Three VideoTexture draw.
// 45: independent-axis reference tracks and their saved geometry must bypass older workers/caches.
// 46: sparse capture windows retain video before an audio tail for final-frame holds.
// 47: route public X status pages through the supported downloader before import.
// 49: report genuine Gemini billing failures and honor durable admission cooldowns.
// 50: beat maps carry the measured music energy (loudness, low band, onsets) analyzeMusic reads.
// 51: MCP subject selections and noun grounding can request SAM 3.1 on Meta's Model API.
// 52: SAM 3.1 cut-outs report the subject's box per frame (Genesis layers).
// 53: those boxes are measured from the mask's opaque pixels, so they always match the cut-out.
// 54: Genesis jobs: VDA-Small depth passes, LightX relight and depth effects (genesis task kind).
export const MEDIA_PROCESSOR_VERSION = 54;
