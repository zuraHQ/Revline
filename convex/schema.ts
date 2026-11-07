import { clippingManifest,clipCheckRequestValidator } from './lib/clipping_validator';
import { laneValidator, laneEvidenceValidator, laneBaselineValidator, laneResultValidator } from './lib/lane_validators';
import { subjectSelectionValidator } from './lib/pixel_track_validator';
import { pixelTrackRequestValidator, pixelTrackResultValidator, pixelTrackHeaderValidator, pixelTrackSampleValidator, pixelTrackBindingValidator } from './lib/pixel_track_validator';
import { normalizationRequestValidator, normalizationResultValidator } from './lib/normalization_validator';
import {editorCommandValidator} from './lib/editor_command';
import {editorEditModeValidator} from './lib/edit_mode';
import { vMessageDoc, vMessageStatus } from '@convex-dev/agent/validators';
import {storedEditorReasoningEffortValidator, pinnedClaudeModelValidator} from './lib/claude_model';
import { effectPlanValidator, compositionReviewResult } from './lib/effect_plan';
import { cutoutEffectValidator } from './lib/cutout_effect_validator';
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { BEAT_ANALYSIS_ENGINE } from '../lib/media-analysis/beat-map';
import { aiCostRecordFields } from './lib/ai_cost';
import { pacingRequestValidator, pacingResultValidator } from './lib/pacing_validator';
import { soundRequestValidator, soundResultValidator } from './lib/sound_validator';
import { alertFields } from './lib/discord_alert';
import { saveIncidentCondition, saveIncidentEvidence, saveIncidentPublication } from './lib/save_incidents';
import { toolWriteReceipt } from './lib/tool_write_receipt';
import { assistantRunArgs, assistantRecoveryValidator } from './lib/assistant_run';

export const brandColorValidator = v.object({ name: v.string(), value: v.string() });
export const brandFontValidator = v.object({ family: v.string(), weight: v.string(), role: v.union(v.literal('heading'), v.literal('body'), v.literal('other')), url: v.string() });
export const brandContextValidator = v.object({ product: v.optional(v.string()) });
const sceneBrandValidator = v.object({ kitId: v.string(), name: v.string(), colors: v.array(brandColorValidator), fonts: v.array(brandFontValidator), logo: v.optional(v.string()), screens: v.optional(v.array(v.object({ name: v.string(), url: v.string() }))) });
export const blueprintPartValidator = v.object({ name: v.string(), x: v.number(), y: v.number(), width: v.number(), height: v.number(), score: v.optional(v.number()) });
/** One size the blueprint was rendered at and compared with a real screenshot of that size. */
export const blueprintCheckValidator = v.object({ width: v.number(), height: v.number(), score: v.number(), meanDiff: v.number(), at: v.number() });
/** What a blueprint check returns: a render, its diff against the screen, scores, measured colors and edges. */
export const blueprintCheckResultValidator = v.object({
  width: v.number(), height: v.number(),
  image: v.optional(v.string()), diff: v.optional(v.string()), score: v.optional(v.number()), meanDiff: v.optional(v.number()),
  parts: v.optional(v.array(blueprintPartValidator)),
  regions: v.optional(v.array(v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number(), score: v.number() }))),
  colors: v.optional(v.array(v.object({ x: v.number(), y: v.number(), hex: v.string(), label: v.optional(v.string()) }))),
  edges: v.optional(v.array(v.object({ axis: v.union(v.literal('x'), v.literal('y')), at: v.number(), from: v.number(), to: v.number(), label: v.optional(v.string()), changes: v.array(v.object({ at: v.number(), before: v.string(), after: v.string() })) }))),
});
export const blueprintPointValidator = v.object({ x: v.number(), y: v.number(), label: v.optional(v.string()) });
export const blueprintLineValidator = v.object({ axis: v.union(v.literal('x'), v.literal('y')), at: v.number(), from: v.number(), to: v.number(), label: v.optional(v.string()) });
export const brandScreenValidator = v.object({ name: v.string(), storageId: v.id('_storage'), width: v.optional(v.number()), height: v.optional(v.number()), note: v.optional(v.string()) });

export const aspectRatio = v.union(v.literal("vertical"), v.literal("square"), v.literal("landscape"), v.literal("portrait-feed"), v.literal("classic"));
export const assetKind = v.union(v.literal("video"), v.literal("audio"), v.literal("image"), v.literal("model"));
/** What a cloud storage upload may hold. */
export const cloudMediaKind = v.union(v.literal('video'), v.literal('audio'), v.literal('image'));
/** A stored file's kind: any media asset, or an export. */
export const storageObjectKind = v.union(assetKind, v.literal('export'));
export const waveformValidator = v.object({ peaks: v.string(), samplesPerSecond: v.number() });
export const focusValidator = v.array(v.object({ time: v.number(), x: v.number(), y: v.number() }));
export const motionKeyframeValidator = v.object({ time: v.number(), x: v.number(), y: v.number(), scale: v.number(), rotation: v.number(), opacity: v.number(), brightness: v.number() });
export const smoothZoomValidator = v.object({ start: v.number(), inDuration: v.number(), holdDuration: v.number(), outDuration: v.number(), scale: v.number(), centerX: v.number(), centerY: v.number(), framing: v.optional(v.union(v.literal('anchor'), v.literal('center'))), easing: v.union(v.literal('linear'), v.literal('ease-in-out'), v.literal('ease-out'), v.literal('focused-spring')) });
export const cameraMotionValidator = v.object({ blurAmount:v.optional(v.number()), keyframes:v.array(v.object({time:v.number(),scale:v.number(),centerX:v.number(),centerY:v.number(),easing:smoothZoomValidator.fields.easing})) });
export const colorGradeValidator = v.object({ enabled: v.boolean(), exposure: v.number(), contrast: v.number(), saturation: v.number(), temperature: v.number(), tint: v.number(), vibrance: v.number() });
export const zoomBlurValidator = v.object({ enabled: v.boolean(), amount: v.number(), centerX: v.number(), centerY: v.number() });
export const invertValidator = v.object({ enabled: v.boolean(), amount: v.number() });
export const ditherValidator = v.object({ enabled: v.boolean(), amount: v.number(), levels: v.number(), size: v.number(), shadowColor: v.optional(v.string()), highlightColor: v.optional(v.string()) });
export const glitchValidator = v.object({ enabled: v.boolean(), intensity: v.number(), blockSize: v.number(), rgbSplit: v.number() });
export const textTemplateValidator = v.object({ preset: v.union(v.literal('word-reveal'), v.literal('word-pop'), v.literal('slide-title'), v.literal('karaoke'), v.literal('neon-echo'), v.literal('lyric-slam'), v.literal('kinetic-stack'), v.literal('rgb-split'), v.literal('type-trails'), v.literal('blur-focus'), v.literal('character-scramble'), v.literal('spotlight-sweep'), v.literal('ink-write'), v.literal('tunnel-zoom')), highlightColor: v.optional(v.string()), strength:v.optional(v.number()), revealDuration:v.optional(v.number()), stagger:v.optional(v.number()), duration: v.optional(v.number()), offset: v.optional(v.number()), wordTimings:v.optional(v.array(v.object({start:v.number(),end:v.number()}))), karaokeStyle:v.optional(v.union(v.literal('box'),v.literal('pop'))) });
export const textGradientValidator = v.object({colors:v.array(v.string()),angle:v.number(),animation:v.optional(v.object({duration:v.number(),direction:v.union(v.literal('forward'),v.literal('reverse')),loop:v.boolean()})),offset:v.optional(v.number())});
export const textStyleValidator = v.object({strokeWidth:v.number(),strokeColor:v.string(),shadowBlur:v.number(),shadowX:v.number(),shadowY:v.number(),shadowColor:v.string(),glowBlur:v.number(),glowColor:v.string(),fontWeight:v.optional(v.number()),italic:v.optional(v.boolean()),letterSpacing:v.optional(v.number()),lineHeight:v.optional(v.number()),textAlign:v.optional(v.union(v.literal('left'),v.literal('center'),v.literal('right'))),paddingX:v.optional(v.number()),paddingY:v.optional(v.number()),borderRadius:v.optional(v.number())});
export const audioSettingsValidator=v.object({role:v.union(v.literal('original'),v.literal('voice'),v.literal('music')),fadeIn:v.number(),fadeOut:v.number(),ducking:v.object({enabled:v.boolean(),amount:v.number(),attack:v.number(),release:v.number()})});
const clipApprovalValidator = v.object({ note: v.optional(v.string()), at: v.number(), by: v.union(v.literal('user'), v.literal('agent')) });
export const clipValidator = v.object({
  id: v.string(), kind: v.union(v.literal("video"), v.literal("audio"), v.literal("image"), v.literal("caption"), v.literal("graphic"), v.literal("solid"), v.literal("scene"), v.literal("effect")),
  normalizedAudio:v.optional(v.object({assetId:v.string(),key:v.string(),targetLufs:v.number(),truePeak:v.number(),offset:v.optional(v.number()),outputLufs:v.optional(v.number()),measuredTruePeak:v.optional(v.number())})), assetId: v.optional(v.string()), focus: v.optional(focusValidator), framingCuts:v.optional(v.array(v.number())), track: v.optional(v.number()), start: v.number(), duration: v.number(), sourceStart: v.number(),
  playbackRate: v.optional(v.number()),
  audio:v.optional(audioSettingsValidator),
  audioFadeTiming:v.optional(v.object({duration:v.number(),offset:v.number()})),
  visualFade:v.optional(v.object({fadeIn:v.number(),fadeOut:v.number()})),
  visualFadeTiming:v.optional(v.object({duration:v.number(),offset:v.number()})),
  frameShrink:v.optional(v.object({size:v.number(),speed:v.number()})),
  impact: v.optional(v.object({preset:v.union(v.literal('invert'),v.literal('black-white'),v.literal('posterize'),v.literal('manga')),intensity:v.number(),threshold:v.number(),levels:v.number(),speedLines:v.number(),flash:v.number(),centerX:v.number(),centerY:v.number()})),
  overlay: v.optional(v.object({preset:v.union(v.literal('light-leak'),v.literal('film-burn'),v.literal('lens-flare'),v.literal('dust'),v.literal('grain')),blend:v.union(v.literal('screen'),v.literal('add'),v.literal('overlay')),intensity:v.number(),color:v.string(),seed:v.number(),speed:v.number(),fade:v.number()})),
  overlayTiming:v.optional(v.object({duration:v.number(),offset:v.number()})),
  parallax: v.optional(v.object({duration:v.number(),amount:v.number(),panX:v.number(),panY:v.number(),orbit:v.number(),zoom:v.number()})),
  flash:v.optional(v.object({strength:v.number(),attack:v.number(),release:v.number()})),
  punch:v.optional(v.object({amount:v.number(),speed:v.number(),centerX:v.number(),centerY:v.number(),attack:v.optional(v.number()),release:v.optional(v.number())})),
  shake:v.optional(v.object({strength:v.number(),speed:v.number(),direction:v.union(v.literal('both'),v.literal('horizontal'),v.literal('vertical'))})),
  pop:v.optional(v.object({startScale:v.number(),bounce:v.number(),speed:v.number()})),
  zoom:v.optional(v.object({direction:v.union(v.literal('in'),v.literal('out')),amount:v.number(),speed:v.number(),centerX:v.number(),centerY:v.number()})),
  transform: v.optional(v.object({ x: v.number(), y: v.number(), scale: v.number(), rotation: v.number(), opacity: v.number() })),
  crop: v.optional(v.object({ top: v.number(), right: v.number(), bottom: v.number(), left: v.number() })),
  fit: v.optional(v.union(v.literal("cover"), v.literal("contain"))),
  text: v.optional(v.string()), fontSize: v.optional(v.number()), color: v.optional(v.string()),
  background: v.optional(v.string()), x: v.optional(v.number()), y: v.optional(v.number()), volume: v.optional(v.number()),
  linkedClipId: v.optional(v.string()), audioSeparated: v.optional(v.boolean()),
  blendMode: v.optional(v.union(v.literal("normal"), v.literal("screen"), v.literal("multiply"), v.literal("overlay"), v.literal("plus-lighter"), v.literal("difference"))),
  motion: v.optional(v.array(motionKeyframeValidator)), motionOffset: v.optional(v.number()),
  motionBlur: v.optional(v.number()), pixelTracking: v.optional(pixelTrackBindingValidator),
  mask: v.optional(v.object({ active: v.optional(v.object({ start: v.number(), end: v.number() })), shape: v.union(v.literal('rectangle'), v.literal('ellipse'), v.literal('polygon'), v.literal('text')), invert: v.optional(v.boolean()), radius: v.optional(v.number()), points: v.optional(v.array(v.array(v.number()))), text: v.optional(v.string()), keys: v.array(v.object({ time: v.number(), x: v.number(), y: v.number(), width: v.number(), height: v.number(), rotation: v.number(), feather: v.number() })) })),
  colorCurves: v.optional(v.object({ master: v.optional(v.array(v.array(v.number()))), red: v.optional(v.array(v.array(v.number()))), green: v.optional(v.array(v.array(v.number()))), blue: v.optional(v.array(v.array(v.number()))) })),
  hsl: v.optional(v.record(v.string(), v.object({ hue: v.number(), saturation: v.number(), luminance: v.number() }))),
  lut: v.optional(v.object({ look: v.string(), amount: v.number() })),
  bloom: v.optional(v.object({ enabled: v.boolean(), amount: v.number(), threshold: v.number(), radius: v.number() })),
  audioReactive: v.optional(v.object({ rate: v.number(), start: v.number(), levels: v.string(), targets: v.array(v.object({ property: v.string(), amount: v.number() })) })),
  speedRamp: v.optional(v.array(v.object({ t: v.number(), v: v.number() }))),
  effectKeyframes: v.optional(v.array(v.object({ control: v.string(), keys: v.array(v.object({ time: v.number(), value: v.number() })) }))),
  smoothZoom: v.optional(smoothZoomValidator), cameraMotion:v.optional(cameraMotionValidator),
  colorGrade: v.optional(colorGradeValidator), zoomBlur: v.optional(zoomBlurValidator), glitch: v.optional(glitchValidator), invert: v.optional(invertValidator), dither: v.optional(ditherValidator),
  neonEdges:v.optional(v.object({enabled:v.boolean(),amount:v.number(),color:v.string(),detail:v.number(),threshold:v.number(),glow:v.number()})),
  softBlur:v.optional(v.object({enabled:v.boolean(),amount:v.number()})),
  flip:v.optional(v.object({horizontal:v.optional(v.boolean()),vertical:v.optional(v.boolean())})),
  frameCorners:v.optional(v.object({enabled:v.boolean(),amount:v.number()})),
  outline:v.optional(v.object({enabled:v.boolean(),color:v.string(),width:v.number(),glow:v.number()})),
  lensDistortion:v.optional(v.object({enabled:v.boolean(),amount:v.number(),centerX:v.number(),centerY:v.number(),fringing:v.number()})),
  frameDistortion:v.optional(v.object({enabled:v.boolean(),horizontal:v.number(),vertical:v.number(),skew:v.number(),bend:v.optional(v.number())})),
  filmOverlay:v.optional(v.object({enabled:v.boolean(),amount:v.number(),grain:v.number(),dust:v.number(),scratches:v.number(),vignette:v.number(),flicker:v.number(),warmth:v.number()})),
  directionalBlur:v.optional(v.object({enabled:v.boolean(),amount:v.number(),angle:v.number()})),
  turbulentDisplace:v.optional(v.object({enabled:v.boolean(),amount:v.number(),scale:v.number(),speed:v.number()})),
  lightSweep:v.optional(v.object({enabled:v.boolean(),amount:v.number(),color:v.string(),angle:v.number(),position:v.number(),width:v.number(),speed:v.number()})),
  vhs:v.optional(v.object({enabled:v.boolean(),amount:v.number(),scanlines:v.number(),noise:v.number(),bleed:v.number(),tracking:v.number(),speed:v.number()})),
  lightLeak:v.optional(v.object({enabled:v.boolean(),amount:v.number(),color:v.string(),position:v.number(),spread:v.number(),speed:v.number()})),
  // Stored timelines keep scene and blueprint code in sceneCode rows: `code` is empty and `codeRef` its hash.
  scene: v.optional(v.object({ title: v.string(), code: v.string(), codeRef: v.optional(v.string()), brand: v.optional(sceneBrandValidator), media: v.optional(v.array(v.object({ name: v.string(), assetId: v.string() }))), blueprints: v.optional(v.array(v.object({ name: v.string(), code: v.string(), codeRef: v.optional(v.string()) }))), film: v.optional(v.object({ duration: v.number(), builtThrough: v.optional(v.number()), referenceAssetId: v.optional(v.string()), referenceStart: v.optional(v.number()) })) })),
  textTemplate: v.optional(textTemplateValidator),
  textStyle:v.optional(textStyleValidator), textGradient:v.optional(textGradientValidator),
  fontFamily:v.optional(v.union(v.literal('space-grotesk'),v.literal('anton'),v.literal('dm-serif'),v.literal('geist-mono'),v.literal('inter'),v.literal('dm-sans'),v.literal('montserrat'),v.literal('poppins'),v.literal('oswald'),v.literal('bebas-neue'),v.literal('playfair-display'),v.literal('caveat'),v.literal('tiktok-sans'),v.literal('barlow-condensed'),v.literal('ibm-plex-mono'),v.literal('lora'),v.literal('archivo-black'),v.literal('fraunces'))),
  effectPreset: v.optional(v.union(v.literal('none'), v.literal('fade'), v.literal('punch'), v.literal('shake'), v.literal('flash'), v.literal('pop'), v.literal('cinematic-bars'), v.literal('quick-zoom-in'), v.literal('quick-zoom-out'),v.literal('frame-shrink'), v.literal('zoom-blur'), v.literal('impact-frame'), v.literal('texture-overlay'), v.literal('solid-color'),v.literal('crossfade'),v.literal('spin-zoom'),v.literal('blur-dissolve'),v.literal('gradient-wipe'),v.literal('iris-wipe'),v.literal('whip-pan'),v.literal('zoom-through'),v.literal('film-burn'))),
  cinematicBars: v.optional(v.object({ size: v.number(), speed: v.number() })),
  solidColor:v.optional(v.object({color:v.string(),width:v.number(),height:v.number(),x:v.number(),y:v.number(),opacity:v.number()})),
  transition:v.optional(v.object({fromClipId:v.string(),toClipId:v.string(),direction:v.union(v.literal('clockwise'),v.literal('counter-clockwise')),wipeDirection:v.optional(v.union(v.literal('left'),v.literal('right'),v.literal('up'),v.literal('down'))),softness:v.optional(v.number()),centerX:v.optional(v.number()),centerY:v.optional(v.number()),shape:v.optional(v.union(v.literal('circle'),v.literal('ellipse'))),whipDirection:v.optional(v.union(v.literal('left'),v.literal('right'),v.literal('up'),v.literal('down'),v.literal('zoom'),v.literal('zoom-out'))),travel:v.optional(v.number()),blur:v.optional(v.number())})),
  animation: v.optional(v.union(v.literal("none"), v.literal("fade"), v.literal("rise"))),
  textAnimationTiming:v.optional(v.object({duration:v.number(),offset:v.number()})),
  approval:v.optional(clipApprovalValidator),
  approvedSections:v.optional(v.array(v.object({...clipApprovalValidator.fields,id:v.string(),start:v.number(),end:v.number(),label:v.optional(v.string())}))),
});
export const timelineMarkerValidator = v.object({ id: v.string(), time: v.number(), label: v.optional(v.string()), kind: v.optional(v.literal('section')) });
// Legacy: timelines saved while sections existed may still hold them; saving drops them.
const timelineSectionValidator = v.object({ id: v.string(), name: v.string(), start: v.number(), end: v.number() });
export const timelineValidator = v.object({ audioNormalization:v.optional(v.object({assetId:v.string(),key:v.string(),targetLufs:v.number(),truePeak:v.number(),offset:v.optional(v.number()),outputLufs:v.optional(v.number()),measuredTruePeak:v.optional(v.number())})), clips: v.array(clipValidator), fps: v.number(), aspectRatio, tracks: v.optional(v.object({ visual: v.number(), overlay: v.number(), audio: v.number(), effects: v.optional(v.number()) })), markers: v.optional(v.array(timelineMarkerValidator)), sections: v.optional(v.array(timelineSectionValidator)), luts: v.optional(v.array(v.object({ id: v.string(), name: v.string(), size: v.number(), data: v.string() }))) });
export const aiStateFields = {
  aiQueuePaused:v.optional(v.boolean()), aiWorkflowId:v.optional(v.string()), aiRunning: v.optional(v.boolean()), aiEditing: v.optional(v.boolean()), aiError: v.optional(v.string()), aiRunId: v.optional(v.string()), aiUndoRecorded: v.optional(v.boolean()), aiCheckpointRevision: v.optional(v.number()),
  aiAnalysisUsage:v.optional(v.object({runId:v.string(),enqueued:v.number(),videoUnavailable:v.optional(v.string())})),
  // The connected app driving an MCP run (its OAuth client name), shown in the editor's chat.
  aiAgentName:v.optional(v.string()),
  // An MCP agent counts as working until this time; every tool call on the project extends it.
  aiAgentActiveUntil:v.optional(v.number()),
  // An MCP call on another tab borrows it for the call; the tab open before it reopens when the run ends.
  aiReturnTimelineId:v.optional(v.string()),
  aiRequest:v.optional(v.object({prompt:v.string(),messageId:v.string(),startedRevision:v.number()})),aiRecovery:v.optional(assistantRecoveryValidator),
};
export const projectFields = {
  deleting:v.optional(v.boolean()), deletionJobId:v.optional(v.id('_scheduled_functions')), title: v.string(), ownerId: v.string(), aspectRatio, createdAt: v.number(), updatedAt: v.number(),
  timeline: v.optional(timelineValidator), revision: v.optional(v.number()), history: v.optional(v.array(timelineValidator)),
  threadId:v.optional(v.string()), ...aiStateFields,
  // Timeline tabs: the open tab's timeline is `timeline`; the others live in projectTimelines.
  timelineTabs:v.optional(v.array(v.object({id:v.string(),name:v.string(),aspectRatio:v.optional(aspectRatio),duration:v.optional(v.number()),clipCount:v.optional(v.number())}))), activeTimelineId:v.optional(v.string()),
};
export const projectDocument = v.object({ _id: v.id("projects"), _creationTime: v.number(), ...projectFields });
export const timedText = v.object({ start: v.number(), end: v.number(), text: v.string() });
const transcriptWordValidator = v.object({ ...timedText.fields, speaker:v.optional(v.number()), speakerConfidence:v.optional(v.number()) });
export const transcriptValidator = v.object({ wordChunks:v.optional(v.array(v.array(transcriptWordValidator))), segments: v.array(timedText), words: v.array(transcriptWordValidator), version: v.optional(v.number()),chunkCount:v.optional(v.number()),wordCount:v.optional(v.number()) });
export const audioActivityValidator = v.object({ version: v.literal(1), duration: v.number(), frameSeconds: v.literal(.01), quiet: v.array(v.object({ start: v.number(), end: v.number() })), level: v.object({ noiseFloorDb: v.number(), speechDb: v.number(), quietThresholdDb: v.number(), separationDb: v.number() }), reliable: v.boolean() });
export const understandingValidator = v.object({ summary: v.string(), scenes: v.array(v.object({ start: v.number(), end: v.number(), description: v.string(), score: v.number() })), suggestions: v.optional(v.array(v.object({ label: v.string(), prompt: v.string(), start: v.number(), end: v.number() }))) });
export const shotsValidator = v.object({ fps: v.number(), sourceTiming: v.optional(v.object({ basis: v.literal('pts'), videoStart: v.number(), videoEnd: v.number(), frameCount: v.number() })), shots: v.array(v.object({ start: v.number(), end: v.number(), startFrame: v.number(), endFrame: v.number() })) });
const audioHitValidator = v.object({ time: v.number(), strength: v.number() });
export const beatsValidator = v.object({ beats: v.array(v.number()), bpm: v.number(), confidence: v.number(), engine: v.optional(v.literal(BEAT_ANALYSIS_ENGINE)), downbeats: v.optional(v.array(v.number())), accents: v.optional(v.array(audioHitValidator)), dropCandidates: v.optional(v.array(audioHitValidator)), energy: v.optional(v.object({ step: v.number(), loudness: v.array(v.number()), low: v.array(v.number()), onsets: v.array(v.number()) })) });
/** Measured speech cleanup in SOURCE seconds: what to remove and why (lib/speech-cleanup). */
export const speechCleanupValidator = v.object({ version: v.number(), cuts: v.array(v.object({ kind: v.union(v.literal('pause'), v.literal('breath'), v.literal('filler'), v.literal('restart')), start: v.number(), end: v.number(), confidence: v.number(), detail: v.string() })), edges: v.optional(v.array(v.number())) });
const clippingRect = v.object({ x:v.number(), y:v.number(), w:v.number(), h:v.number() });
export const facecamValidator = v.object({ version:v.literal(1), samples:v.array(v.object({ time:v.number(), kind:v.union(v.literal('overlay'),v.literal('creator-only'),v.literal('gameplay-only'),v.literal('uncertain')), facecam:v.union(clippingRect,v.null()), gameplay:v.union(clippingRect,v.null()), confidence:v.number(), reason:v.string() })) });
export const highlightSourceTypeValidator=v.union(v.literal('podcast'),v.literal('gaming'),v.literal('irl'),v.literal('sports'),v.literal('talk'));
export const speakerRequestValidator=v.object({start:v.number(),end:v.number()});
const speakerFields = { start:v.number(),end:v.number(),identityScope:v.union(v.literal('source'),v.literal('window')), turns:v.array(v.object({ start:v.number(), end:v.number(), speaker:v.number(), confidence:v.number(), face:v.union(clippingRect,v.null()) })), focus:focusValidator };
export const speakersValidator = v.union(
  v.object({ ...speakerFields, version:v.literal(1) }),
  v.object({ ...speakerFields, version:v.literal(2), framing:v.array(v.object({ start:v.number(),end:v.number(),shot:v.number(),method:v.union(v.literal('shot-dominant'),v.literal('turn-mouth'),v.literal('identity-reuse'),v.literal('fallback')),confidence:v.number(),face:v.union(clippingRect,v.null()),faceId:v.union(v.number(),v.null()),speaker:v.union(v.number(),v.null()) })) }),
);
export const analysisValidator = v.object({ highlights:v.optional(v.string()), facecam:v.optional(facecamValidator), speakers:v.optional(speakersValidator), transcript: v.optional(transcriptValidator), audioActivity: v.optional(audioActivityValidator), speechCleanup: v.optional(speechCleanupValidator), understanding: v.optional(understandingValidator), shots: v.optional(shotsValidator), beats: v.optional(beatsValidator), focus: v.optional(focusValidator),
  // A reference breakdown (lib/media-analysis/reference.ts) as validated JSON: shots, their parts and the style to borrow.
  reference: v.optional(v.string()) });
export const frameRequestValidator = v.object({ start: v.number(), end: v.number(), question: v.string() });
export const referenceBox = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() });
export const referenceCropKeyframesValidator = v.array(v.object({ time: v.number(), crop: referenceBox }));
/** What a reference read produces: a frame sheet, a tracked box, measured pixels, and so on. */
export const referenceReadMode = v.union(v.literal('sheet'), v.literal('track'), v.literal('measure'), v.literal('compare'), v.literal('trace'), v.literal('font'), v.literal('sounds'), v.literal('motion'));
/** The short side, in pixels, of rendered timeline frames. */
export const frameResolution = v.union(v.literal(720), v.literal(1080));
export const referenceReadResult = v.object({ motion: v.optional(v.any()), sounds: v.optional(v.array(v.object({ time: v.number(), end: v.number(), level: v.number(), hit: v.optional(v.number()), kind: v.optional(v.string()), description: v.optional(v.string()), prompt: v.optional(v.string()), onScreen: v.optional(v.string()) }))), music: v.optional(v.object({ present: v.boolean(), description: v.string(), prompt: v.string() })), silentHits: v.optional(v.array(v.number())), fonts: v.optional(v.array(v.object({ family: v.string(), weight: v.number(), style: v.union(v.literal('normal'), v.literal('italic')), category: v.string(), score: v.number() }))), fontColors: v.optional(v.object({ ink: v.string(), background: v.string() })), image: v.optional(v.string()), extraImages: v.optional(v.array(v.string())), width: v.number(), height: v.number(), sourceWidth: v.number(), sourceHeight: v.number(), fps: v.number(), frames: v.array(v.object({ time: v.number(), change: v.optional(v.number()), changed: v.optional(referenceBox) })), moments: v.optional(v.array(v.object({ start: v.number(), end: v.number(), peak: v.number(), kind: v.union(v.literal('cut'), v.literal('motion')), region: v.optional(referenceBox) }))), holds: v.optional(v.array(v.object({ start: v.number(), end: v.number() }))), scores: v.optional(v.array(v.object({ time: v.number(), difference: v.number() }))), track: v.optional(v.array(v.object({ time: v.number(), x: v.number(), y: v.number(), w: v.number(), h: v.number(), scale: v.number(), scaleX: v.optional(v.number()), scaleY: v.optional(v.number()), registrationBox: v.optional(referenceBox), corners: v.optional(v.array(v.array(v.number()))), rotation: v.number(), confidence: v.number(), visible: v.optional(v.boolean()), opacity: v.optional(v.number()), opacityConfidence: v.optional(v.number()), sharpness: v.optional(v.number()) }))), trackingNotes: v.optional(v.array(v.string())), moves: v.optional(v.array(v.object({ start: v.number(), end: v.number(), duration: v.number(), from: v.object({ x: v.number(), y: v.number(), scale: v.number(), scaleX: v.optional(v.number()), scaleY: v.optional(v.number()), rotation: v.number(), opacity: v.optional(v.number()) }), to: v.object({ x: v.number(), y: v.number(), scale: v.number(), scaleX: v.optional(v.number()), scaleY: v.optional(v.number()), rotation: v.number(), opacity: v.optional(v.number()) }), ease: v.string(), fit: v.number(), gsap: v.string() }))), colors: blueprintCheckResultValidator.fields.colors, edges: blueprintCheckResultValidator.fields.edges, trace: v.optional(v.object({ box: referenceBox, svg: v.string(), paths: v.array(v.object({ d: v.string(), fill: v.string() })), color: v.string(), background: v.string(), coverage: v.number(), centerline: v.optional(v.object({ d: v.string(), width: v.number(), length: v.number() })) })) });
export const frameTargetValidator=v.object({frameIndex:v.number(),time:v.number(),label:v.string(),confidence:v.union(v.literal('low'),v.literal('medium'),v.literal('high')),box:v.object({left:v.number(),top:v.number(),right:v.number(),bottom:v.number()})});
export const frameInspectionValidator = v.object({ ...frameRequestValidator.fields, geometry:v.optional(v.object({sourceWidth:v.number(),sourceHeight:v.number(),decodedWidth:v.number(),decodedHeight:v.number()})),targets:v.optional(v.array(frameTargetValidator)),sourceFps: v.number(), sampleInterval: v.number(), consecutive: v.boolean(), summary: v.string(), uncertainty: v.string(), frames: v.array(v.object({ frameIndex: v.number(), time: v.number(), observation: v.string() })), events: v.array(v.object({ frameIndex: v.number(), time: v.number(), description: v.string(), confidence: v.union(v.literal('low'), v.literal('medium'), v.literal('high')) })) });
export const videoRequestValidator = v.object({ start: v.number(), end: v.number(), question: v.string() });
export const videoInspectionValidator = v.object({ ...videoRequestValidator.fields, summary: v.string(), uncertainty: v.string(), matches: v.array(v.object({ start: v.number(), end: v.number(), description: v.string() })) });
export const analysisMode = v.union(v.literal('highlights'),v.literal("transcribe"), v.literal("understand"), v.literal("shots"), v.literal("beats"), v.literal("track"), v.literal('frames'), v.literal('video'), v.literal('reference'), v.literal('facecam'), v.literal('speakers'));
const analysisRequestFields = { ownerId: v.string(), projectId: v.id("projects"), assetId: v.id("assets"), aiRunId: v.string(), mode: analysisMode, highlightSkipGemini:v.optional(v.string()),highlightSourceType:v.optional(highlightSourceTypeValidator),speakerRequest:v.optional(speakerRequestValidator),speakerInspection:v.optional(speakersValidator), frameRequest: v.optional(frameRequestValidator), frameInspection: v.optional(frameInspectionValidator), videoRequest: v.optional(videoRequestValidator), videoInspection: v.optional(videoInspectionValidator), taskId: v.optional(v.id('mediaTasks')), status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed")), error: v.optional(v.string()), createdAt: v.number(), expiresAt: v.number() };
export const analysisRequestDocument = v.object({ _id: v.id("analysisRequests"), _creationTime: v.number(), ...analysisRequestFields });
export const previewFields = { previewR2Key:v.optional(v.string()), previewSize:v.optional(v.number()), previewWidth:v.optional(v.number()), previewHeight:v.optional(v.number()), previewFps:v.optional(v.number()), previewVersion:v.optional(v.number()) };
export const previewSegmentUrl = v.object({ start:v.number(), end:v.number(), url:v.string(), size:v.number() });
export const imageGenerationValidator = v.object({
  requestId: v.string(), prompt: v.string(), model: v.string(), size: v.string(), transparentBackground: v.boolean(),
  referenceAssetIds: v.array(v.id('assets')), quality: v.union(v.literal('low'), v.literal('medium')),
  usage: v.object({ inputTokens: v.union(v.number(), v.null()), outputTokens: v.union(v.number(), v.null()), textTokens: v.union(v.number(), v.null()), imageTokens: v.union(v.number(), v.null()), estimatedUsd: v.union(v.number(), v.null()) }),
});
export const assetFields = {
  motionReferenceTimelines: v.optional(v.array(v.string())),
  imageGeneration: v.optional(imageGenerationValidator),
  importSourceUrl:v.optional(v.string()),importRange:v.optional(v.object({start:v.number(),end:v.number()})),
  previewOriginalPlayable:v.optional(v.boolean()),
  ...previewFields,
  ownerId: v.string(), projectId: v.id("projects"), storageId: v.optional(v.id("_storage")), r2Key: v.optional(v.string()), fileName: v.string(),
  contentType: v.string(), size: v.number(), kind: assetKind, createdAt: v.number(),
  duration: v.optional(v.number()), width: v.optional(v.number()), height: v.optional(v.number()), analysisId:v.optional(v.id('assetAnalyses')),analysisKinds:v.optional(v.array(v.string())),editSuggestions:understandingValidator.fields.suggestions, analysis: v.optional(analysisValidator), analysisUpdatedAt: v.optional(v.number()),
  audioAssetId: v.optional(v.id("assets")), audioExtracted: v.optional(v.boolean()),
  waveform: v.optional(waveformValidator),
  // JSON recipe of an assistant-generated sound effect; editSound re-renders from it.
  soundRecipe: v.optional(v.string()),
  // A background-removed copy (VP9 with alpha) of cutoutOf on the same source timeline;
  // frames before cutoutStart are transparent padding.
  cutoutOf: v.optional(v.id('assets')), cutoutStart: v.optional(v.number()),
  // A processed copy of derivedOf: a freeze-frame still, or smooth slow-motion / upscaled video on the same
  // source timeline (frames before derivedStart are black padding).
  derivedOf: v.optional(v.id('assets')), derivedStart: v.optional(v.number()), derivation: v.optional(v.union(v.literal('freeze'), v.literal('slowmo'), v.literal('upscale'), v.literal('parallax'))),
  thumbnailStorageId: v.optional(v.id('_storage')),
  analysisCompletedAt: v.optional(v.object({ transcribe: v.optional(v.number()), understand: v.optional(v.number()), shots: v.optional(v.number()), beats: v.optional(v.number()), track: v.optional(v.number()) })),
};
export const assetDocument = v.object({ _id: v.id("assets"), _creationTime: v.number(), ...assetFields });
export const assetWithUrl = v.object({ _id: v.id("assets"), _creationTime: v.number(), ...assetFields, url: v.union(v.string(), v.null()), previewUrl:v.optional(v.union(v.string(),v.null())), previewSegments:v.optional(v.array(previewSegmentUrl)), thumbnailUrl:v.optional(v.union(v.string(),v.null())) });
export const renderFields = {
  ownerId: v.string(), projectId: v.id("projects"),
  status: v.union(v.literal("queued"), v.literal("rendering"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
  outputStorageId: v.optional(v.id("_storage")), outputR2Key: v.optional(v.string()), outputSize: v.optional(v.number()), error: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  sourceRevision:v.optional(v.number()), sourceClipId:v.optional(v.string()), sourceSectionId:v.optional(v.string()), sourceTimelineId:v.optional(v.string()), label:v.optional(v.string()), timeline: v.optional(timelineValidator), resolution: v.optional(v.number()), fps: v.optional(v.number()), quality: v.optional(v.string()),
  progress: v.optional(v.number()), assetIds: v.optional(v.array(v.id("assets"))), taskId: v.optional(v.id('mediaTasks')),
};
export const renderDocument = v.object({ _id: v.id("renderJobs"), _creationTime: v.number(), ...renderFields, url: v.union(v.string(), v.null()) });
const {timeline:_snapshot,...renderSummaryFields}=renderFields;
export const renderSummaryDocument=v.object({_id:v.id('renderJobs'),_creationTime:v.number(),...renderSummaryFields,url:v.union(v.string(),v.null())});
export const r2UploadFields = {
    ownerId: v.string(), projectId: v.id("projects"), jobId: v.optional(v.id("renderJobs")), taskId: v.optional(v.id('mediaTasks')), taskLeaseToken: v.optional(v.string()), previewRange:v.optional(v.object({start:v.number(),end:v.number()})), purpose:v.optional(v.literal('preview')), sourceAssetId:v.optional(v.id('assets')), previewFps:v.optional(v.number()), previewVersion:v.optional(v.number()),
    key: v.string(), uploadId: v.string(), fileName: v.string(), contentType: v.string(), kind: assetKind,
    size: v.number(), partSize: v.number(), duration: v.optional(v.number()), width: v.optional(v.number()), height: v.optional(v.number()),
    cleanupScheduled:v.optional(v.boolean()), aborting:v.optional(v.boolean()), expiresAt: v.number(), assetId: v.optional(v.id("assets")), completed: v.optional(v.boolean()),
};
export const r2UploadDocument = v.object({ _id: v.id("r2Uploads"), _creationTime: v.number(), ...r2UploadFields });
export const userFields = {
  aiConsentVersion: v.optional(v.number()), aiConsentAt: v.optional(v.number()),
  clerkId: v.string(), email: v.optional(v.string()), name: v.optional(v.string()), imageUrl: v.optional(v.string()),
  createdAt: v.number(), updatedAt: v.number(),
};
export const userDocument = v.object({ _id: v.id("users"), _creationTime: v.number(), ...userFields });
export const mediaTaskKind = v.union(analysisMode, v.literal('extract'), v.literal('preview'), v.literal('waveform'), v.literal('render'), v.literal('import'), v.literal('review'), v.literal('snapshot'), v.literal('cutout'), v.literal('derive'), v.literal('blueprint'), v.literal('read'));
export const mediaTaskStatus = v.union(v.literal('queued'), v.literal('running'), v.literal('retrying'), v.literal('completed'), v.literal('failed'), v.literal('cancelled'));
export const mediaTaskActivity = v.union(v.literal('preparing-playback'),v.literal('downloading'), v.literal('preparing-analysis'), v.literal('sending-gemini'), v.literal('preparing-gemini'), v.literal('analyzing'), v.literal('retrying-analysis'));
export const mediaTaskFields = {
  ownerId: v.string(), projectId: v.id('projects'), kind: mediaTaskKind,
  // Ultra exports run on the 4-vCPU processor slot; other work leaves this unset.
  lane: v.optional(v.literal('ultra')),
  assetId: v.optional(v.id('assets')), renderJobId: v.optional(v.id('renderJobs')), analysisRequestId: v.optional(v.id('analysisRequests')),
  status: mediaTaskStatus, claimable:v.optional(v.boolean()), capacityWaiting:v.optional(v.boolean()), capacityQueued:v.optional(v.boolean()), workflowId: v.optional(v.string()), attempt: v.number(), progress: v.number(),
  activity:v.optional(mediaTaskActivity),activityStartedAt:v.optional(v.number()),
  outputAssetId: v.optional(v.id('assets')),
  sourceUrl: v.optional(v.string()),
  // An optional source window (seconds); full-source imports also support long footage.
  importRange: v.optional(v.object({ start: v.number(), end: v.number() })),
  sourcesOnly: v.optional(v.boolean()),
  reviewId:v.optional(v.id('compositionReviews')),snapshotId:v.optional(v.id('frameSnapshots')),readId:v.optional(v.id('referenceReads')),referenceImport:v.optional(v.boolean()),blueprintCheckId:v.optional(v.id('blueprintChecks')),cutoutId:v.optional(v.id('cutouts')),derivationId:v.optional(v.id('derivations')),previewVersion:v.optional(v.number()),requiredProcessorVersion:v.optional(v.number()),
  frameRequest: v.optional(frameRequestValidator), frameInspection: v.optional(frameInspectionValidator),
  highlightSkipGemini:v.optional(v.string()),highlightSourceType:v.optional(highlightSourceTypeValidator),speakerRequest:v.optional(speakerRequestValidator),
  videoRequest: v.optional(videoRequestValidator), videoInspection: v.optional(videoInspectionValidator),
  leaseToken: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()), attemptStartedAt: v.optional(v.number()),
  error: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
};
export const mediaTaskDocument = v.object({ _id: v.id('mediaTasks'), _creationTime: v.number(), ...mediaTaskFields });
export const sharedAssetFields = {
  ...previewFields,
  ownerId:v.optional(v.string()),
  sourceId:v.id('assets'), storageId:v.optional(v.id('_storage')), r2Key:v.optional(v.string()),
  fileName:v.string(),contentType:v.string(),size:v.number(),kind:assetKind,
  duration:v.optional(v.number()),width:v.optional(v.number()),height:v.optional(v.number()),
  audioAssetId:v.optional(v.id('assets')),audioExtracted:v.optional(v.boolean()),
  waveform:v.optional(waveformValidator),thumbnailStorageId:v.optional(v.id('_storage')),
};
export const publicMediaAsset = v.object({
  previewSize:previewFields.previewSize,previewWidth:previewFields.previewWidth,previewHeight:previewFields.previewHeight,previewFps:previewFields.previewFps,previewVersion:previewFields.previewVersion,
  _id:v.string(),fileName:v.string(),kind:assetKind,url:v.union(v.string(),v.null()),previewUrl:v.optional(v.union(v.string(),v.null())),
  duration:v.optional(v.number()),width:v.optional(v.number()),height:v.optional(v.number()),
  audioAssetId:v.optional(v.string()),audioExtracted:v.optional(v.boolean()),waveform:v.optional(waveformValidator),thumbnailUrl:v.optional(v.union(v.string(),v.null())),
});
export const sharedChatMessage = v.object({role:v.union(v.literal('user'),v.literal('assistant')),text:v.string()});
export const shareChatPreviewMessage = v.object({id:v.string(),...sharedChatMessage.fields});
export default defineSchema({
  geminiBillingCooldowns: defineTable({ ownerId: v.string(), keyHash: v.string(), until: v.number() }).index("by_owner", ["ownerId"]),
  incidents: defineTable({
    fingerprint: v.string(), source: v.string(), kind: v.string(), message: v.string(), stack: v.optional(v.string()), deployment: v.string(),
    count: v.number(), firstSeen: v.number(), lastSeen: v.number(), priority: v.number(), generation: v.number(),
    status: v.union(v.literal('open'), v.literal('pr_open'), v.literal('resolved')),
    delivery: v.union(v.literal('pending'), v.literal('claimed'), v.literal('finished'), v.literal('failed')),
    issueDelivery: v.optional(v.union(v.literal('claimed'), v.literal('finished'), v.literal('failed'))), issueClaimToken: v.optional(v.string()), issueClaimedAt: v.optional(v.number()), issueDeliveredCount: v.optional(v.number()), issueDispatchReady: v.optional(v.boolean()), issueUrl: v.optional(v.string()), issueAttempts: v.optional(v.number()), issueNextAttempt: v.optional(v.number()),
    claimToken: v.optional(v.string()), claimedAt: v.optional(v.number()), prUrl: v.optional(v.string()), deliveryError: v.optional(v.string()),
    samples: v.array(v.object({ at: v.number(), context: v.string(), projectId: v.optional(v.id('projects')), runId: v.optional(v.string()) })),
  }).index('by_kind', ['kind']).index('by_fingerprint', ['fingerprint']).index('by_delivery_priority', ['delivery', 'priority', 'firstSeen']),
  assistantTurnViews:defineTable({projectId:v.id('projects'),promptMessageId:v.string(),runId:v.string(),turnId:v.id('assistantTurns'),segment:v.number(),status:v.union(v.literal('running'),v.literal('completed'),v.literal('failed'),v.literal('stopped')),error:v.optional(v.string()),resuming:v.boolean()}).index('by_run',['runId']).index('by_prompt',['projectId','promptMessageId']).index('by_project',['projectId']),
  assistantTurns: defineTable({
    projectId:v.id('projects'),runId:v.string(),promptMessageId:v.string(),threadId:v.string(),
    args:v.object(assistantRunArgs),timelineId:v.string(),pass:v.number(),segment:v.number(),savedEdits:v.number(),
    pendingFastFrames:v.array(v.number()),feedback:v.optional(v.string()),
    status:v.union(v.literal('running'),v.literal('completed'),v.literal('failed'),v.literal('stopped')),error:v.optional(v.string()),updatedAt:v.number(),
  }).index('by_run',['runId']).index('by_prompt',['projectId','promptMessageId']).index('by_project',['projectId']),
  toolWriteReceipts: defineTable({
    projectId: v.id('projects'), ownerId: v.string(), runId: v.string(), writeId: v.string(),
    toolName: v.string(), functionName: v.string(), receipt: v.optional(toolWriteReceipt), value:v.optional(v.any()), valueParts:v.optional(v.number()), stagedRevision: v.optional(v.number()), expiresAt: v.number(),
  }).index('by_write', ['writeId']).index('by_run_stage', ['runId', 'stagedRevision']).index('by_expires', ['expiresAt']),
  toolWriteResultParts:defineTable({writeId:v.string(),part:v.number(),value:v.string()}).index('by_write_part',['writeId','part']),
  accountDeletions: defineTable({ownerId:v.string(),phase:v.union(v.literal('pending'),v.literal('projects'),v.literal('rows')),table:v.number(),cursor:v.union(v.string(),v.null()),changed:v.boolean(),requestedAt:v.number()}).index('by_owner',['ownerId']),
  deletedAccountTokens: defineTable({subjectHash:v.string(),expiresAt:v.number()}).index('by_hash',['subjectHash']).index('by_expiry',['expiresAt']),
  accountDeletionRefs: defineTable({ownerId:v.string(),resourceId:v.string()}).index('by_owner_resource',['ownerId','resourceId']),
  // Operational diagnostics only. No editor subscription reads these tables.
  saveIncidentRuns: defineTable({
    runId: v.string(), projectId: v.id('projects'), ownerId: v.string(),
    publication: v.optional(saveIncidentPublication), finishedAt: v.optional(v.number()),
  }).index('by_run', ['runId']),
  saveIncidentSteps: defineTable(saveIncidentEvidence)
    .index('by_run_call', ['runId', 'toolCallId']),
  saveIncidentGroups: defineTable({
    deployment: v.union(v.literal('dev'), v.literal('prod')), deploymentName: v.string(),
    fingerprint: v.string(), condition: saveIncidentCondition, toolName: v.string(),
    count: v.number(), firstSeenAt: v.number(), lastSeenAt: v.number(),
    status: v.union(v.literal('open'), v.literal('pr_open'), v.literal('fixed')),
    prUrl: v.optional(v.string()), fixedAt: v.optional(v.number()),
    latest: v.object(saveIncidentEvidence), latestPublication: v.optional(saveIncidentPublication),
  }).index('by_fingerprint', ['fingerprint']).index('by_status_count', ['status', 'count']),
  projectTransferReceipts:defineTable({transferKey:v.string(),transferId:v.string(),sourceDeployment:v.string(),sourceProjectId:v.string(),sourceRevision:v.number(),fingerprint:v.string(),ownerId:v.string(),email:v.string(),projectId:v.id('projects'),shareId:v.id('timelineShares'),createdAt:v.number()}).index('by_key',['transferKey']),
  aiCostRecords:defineTable({ownerId:v.string(),projectId:v.id('projects'),runId:v.string(),threadId:v.optional(v.string()),promptMessageId:v.optional(v.string()),...aiCostRecordFields}).index('by_owner_recorded',['ownerId','recordedAt']).index('by_run_key',['runId','key']).index('by_owner_project_thread_prompt',['ownerId','projectId','threadId','promptMessageId']),
  assistantPlans:defineTable({projectId:v.id('projects'),ownerId:v.string(),runId:v.string(),plans:v.array(effectPlanValidator),originals:v.array(clipValidator),reviews:v.number(),createdAt:v.number()}).index('by_project',['projectId']),
  compositionReviews:defineTable({projectId:v.id('projects'),ownerId:v.string(),runId:v.string(),revision:v.number(),timeline:timelineValidator,reference:timelineValidator,plans:v.array(effectPlanValidator),assetIds:v.array(v.id('assets')),start:v.number(),end:v.number(),taskId:v.optional(v.id('mediaTasks')),status:v.union(v.literal('queued'),v.literal('completed'),v.literal('failed')),result:v.optional(compositionReviewResult),error:v.optional(v.string()),createdAt:v.number()}).index('by_project',['projectId']).index('by_created',['createdAt']),

  assetAnalyses:defineTable({ownerId:v.string(),sourceKey:v.string(),analysis:analysisValidator,updatedAt:v.number()}).index('by_owner_source',['ownerId','sourceKey']),
  clippingRuns:defineTable(clippingManifest).index('by_project_run',['projectId','runId']).index('by_project',['projectId']),
  assetTranscriptChunks:defineTable({ownerId:v.string(),sourceKey:v.string(),chunk:v.number(),words:transcriptValidator.fields.words}).index('by_owner_source',['ownerId','sourceKey','chunk']),
  projectAccess:defineTable({projectId:v.id('projects'),ownerId:v.string(),historyStored:v.optional(v.boolean()),threadId:v.optional(v.string()),deleting:v.optional(v.boolean()),
    // Mirror of the project's tab list, so listing tabs never reads the (large) project document.
    timelineTabs:projectFields.timelineTabs,activeTimelineId:projectFields.activeTimelineId}).index('by_project',['projectId']),
  // Share of the per-request token cap the active run has used, 0–1.
  // A turn running on the Cloudflare agent runner: the attempt that claimed it, its last sign of life (for the
  // watchdog) and the storage files it may read back.
  agentRunnerTurns:defineTable({runId:v.string(),projectId:v.id('projects'),ownerId:v.string(),attempts:v.number(),claimId:v.optional(v.string()),seenAt:v.number(),storageIds:v.optional(v.array(v.string()))}).index('by_runId',['runId']),
  // Request nonces the agent runner bridge has accepted, kept for the signature window so a replay is refused.
  agentRunnerNonces:defineTable({nonce:v.string(),expiresAt:v.number()}).index('by_nonce',['nonce']).index('by_expiresAt',['expiresAt']),
  aiBudgets:defineTable({projectId:v.id('projects'),runId:v.string(),used:v.number(),effort:v.optional(storedEditorReasoningEffortValidator),updatedAt:v.number()}).index('by_project',['projectId']),
  // A film the editor agent is still writing (addFilm/patchScene input streaming): never on project or timeline rows,
  // never a revision, deleted when the call lands or the run ends (convex/filmDrafts.ts).
  filmDrafts:defineTable({projectId:v.id('projects'),ownerId:v.string(),runId:v.string(),timelineId:v.string(),tool:v.union(v.literal('addFilm'),v.literal('patchScene')),title:v.string(),start:v.number(),duration:v.number(),clip:v.optional(clipValidator),sections:v.array(v.object({title:v.string(),start:v.number(),duration:v.number()})),writing:v.optional(v.object({title:v.string(),start:v.number(),duration:v.number()})),planned:v.array(v.object({title:v.string(),start:v.number(),duration:v.number()})),updatedAt:v.number()}).index('by_project',['projectId']),
  aiTimelinePreviews:defineTable({projectId:v.id('projects'),ownerId:v.string(),runId:v.string(),baseRevision:v.number(),timeline:timelineValidator,label:v.string(),changedClipIds:v.array(v.string()),removedClips:v.array(clipValidator),at:v.number(),sequence:v.number(),updatedAt:v.number()}).index('by_project',['projectId']),
  assistantQueue:defineTable({clientPlatform:v.optional(v.literal('ios')),command:v.optional(editorCommandValidator),projectId:v.id('projects'),ownerId:v.string(),prompt:v.string(),pinnedModel:pinnedClaudeModelValidator,editMode:v.optional(editorEditModeValidator),attachedAssetIds:v.optional(v.array(v.id('assets'))),selectedClipId:v.optional(v.string()),selectedClipIds:v.optional(v.array(v.string())),playhead:v.optional(v.number()),timelineId:v.optional(v.string()),error:v.optional(v.string()),createdAt:v.number()}).index('by_project',['projectId']),
  projectRunMetadata:defineTable({projectId:v.id('projects'),revision:v.number()}).index('by_project',['projectId']),
  aiRunPayloads:defineTable({projectId:v.id('projects'),aiRequest:aiStateFields.aiRequest,aiRecovery:aiStateFields.aiRecovery}).index('by_project',['projectId']),
  aiRuns:defineTable({projectId:v.id('projects'),ownerId:v.string(),...aiStateFields}).index('by_project',['projectId']),
  // A stored tab's undo history sits apart from its timeline, so reading tab timelines never reads it.
  projectTimelineHistories:defineTable({projectId:v.id('projects'),timelineId:v.string(),history:v.array(timelineValidator)}).index('by_project_timeline',['projectId','timelineId']),
  projectTimelines:defineTable({projectId:v.id('projects'),ownerId:v.string(),timelineId:v.string(),timeline:timelineValidator,history:v.optional(v.array(timelineValidator))}).index('by_project_timeline',['projectId','timelineId']),
  timelineRevisions:defineTable({projectId:v.id('projects'),ownerId:v.string(),sequence:v.number(),timeline:timelineValidator,key:v.optional(v.string()),keyVersion:v.optional(v.number())}).index('by_project_sequence',['projectId','sequence']),
  // Revision history for agents (listRevisions, restoreClip): one light row per saved timeline edit, and each changed
  // clip's state just before it (null when the edit added it). A clip's state at revision N is the `before` of its
  // first change after N, or its current state. ':timeline' rows hold the tab's other settings (`rest`) the same way.
  revisionLog:defineTable({projectId:v.id('projects'),timelineId:v.string(),revision:v.number(),at:v.number(),by:v.string(),tool:v.optional(v.string()),summary:v.string(),clipIds:v.array(v.string()),fixes:v.optional(v.array(v.object({id:v.string(),clipId:v.string(),summary:v.string(),verification:v.string(),at:v.number(),by:v.string()})))}).index('by_project_revision',['projectId','revision']).index('by_project_tab_revision',['projectId','timelineId','revision']),
  revisionClips:defineTable({projectId:v.id('projects'),timelineId:v.string(),revision:v.number(),clipId:v.string(),before:v.union(clipValidator,v.null()),index:v.optional(v.number()),rest:v.optional(timelineValidator)}).index('by_clip',['projectId','timelineId','clipId','revision']).index('by_project_tab_revision',['projectId','timelineId','revision']).index('by_project_revision',['projectId','revision']),
  // The stored undo snapshots in order (id, fingerprint, serialized size), so edits and the editor read this row instead of every snapshot.
  // Scene and blueprint code by SHA-256 of its text. Rows never change, so editors load each one once.
  sceneCode:defineTable({hash:v.string(),code:v.string()}).index('by_hash',['hash']),
  timelineHistoryIndex:defineTable({projectId:v.id('projects'),keyVersion:v.number(),entries:v.array(v.object({id:v.id('timelineRevisions'),sequence:v.number(),key:v.string(),bytes:v.number()}))}).index('by_project',['projectId']),
  mcpRunTimeouts:defineTable({projectId:v.id('projects'),ownerId:v.string(),runId:v.string(),scheduledId:v.id('_scheduled_functions')}).index('by_run',['runId']).index('by_project',['projectId']),
  projectCatalog:defineTable({agentSummary:v.optional(v.union(v.null(),v.object({name:v.string(),until:v.number(),running:v.boolean()}))),projectId:v.id('projects'),ownerId:v.string(),title:v.string(),aspectRatio,createdAt:v.number(),updatedAt:v.number(),clipCount:v.number(),aiRunning:v.boolean(),deleting:v.optional(v.boolean()),coverKind:v.optional(assetKind),coverStorageId:v.optional(v.id('_storage')),coverR2Key:v.optional(v.string())}).index('by_project',['projectId']).index('by_owner_updated',['ownerId','updatedAt']),
  projectDataMigration:defineTable({key:v.string(),cursor:v.union(v.string(),v.null()),completed:v.boolean()}).index('by_key',['key']),
  storageAccounts: defineTable({ ownerId:v.string(), usedBytes:v.number(), reservedBytes:v.number(), videoBytes:v.number(), audioBytes:v.number(), imageBytes:v.number(), modelBytes:v.optional(v.number()), exportBytes:v.number(), fileCount:v.number() }).index('by_owner',['ownerId']),
  cloudMedia: defineTable({ ownerId:v.string(), r2Key:v.string(), uploadId:v.string(), fileName:v.string(), contentType:v.string(), kind:cloudMediaKind, size:v.number(), partSize:v.number(), duration:v.optional(v.number()), width:v.optional(v.number()), height:v.optional(v.number()), createdAt:v.number(), expiresAt:v.number(), activeAt:v.optional(v.number()), completed:v.boolean(), aborting:v.optional(v.boolean()) }).index('by_owner_completed',['ownerId','completed']).index('by_r2Key',['r2Key']),
  storageObjects: defineTable({ ownerId:v.string(), objectKey:v.string(), r2Key:v.optional(v.string()), storageId:v.optional(v.id('_storage')), fileName:v.string(), kind:storageObjectKind, size:v.number(), createdAt:v.number(), auxiliary:v.boolean(), pending:v.boolean(), jobId:v.optional(v.id('renderJobs')) })
    .index('by_owner_key',['ownerId','objectKey']).index('by_owner_visible_size',['ownerId','auxiliary','pending','size']).index('by_owner_visible_created',['ownerId','auxiliary','pending','createdAt'])
    .index('by_owner_kind_size',['ownerId','auxiliary','pending','kind','size']).index('by_owner_kind_created',['ownerId','auxiliary','pending','kind','createdAt'])
    .searchIndex('search_name',{searchField:'fileName',filterFields:['ownerId','auxiliary','pending','kind']}),
  storageAccounting: defineTable({ name:v.string(), ready:v.boolean() }).index('by_name',['name']),
  editorEntitlements: defineTable({ ownerId: v.string(), reason: v.string(), grantedAt: v.number(), updatedAt: v.number(), expiresAt: v.optional(v.number()), revokedAt: v.optional(v.number()), plan: v.optional(v.literal('ultra')) }).index('by_owner', ['ownerId']),
  appleBillingAccounts: defineTable({ ownerId: v.string(), appAccountToken: v.string(), createdAt: v.number() }).index('by_owner', ['ownerId']).index('by_token', ['appAccountToken']),
  appleEntitlements: defineTable({
    ownerId: v.string(), transactionId: v.string(), originalTransactionId: v.string(), productId: v.string(),
    plan: v.union(v.literal('pro'), v.literal('ultra')), environment: v.union(v.literal('Sandbox'), v.literal('Production')),
    purchasedAt: v.number(), expiresAt: v.number(), accessUntil: v.number(), eventAt: v.number(), supersededAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()), refundReversedAt: v.optional(v.number()), autoRenew: v.optional(v.boolean()), billingIssue: v.optional(v.boolean()),
    modelPayment: v.optional(v.union(v.literal('paid'), v.literal('free'))), modelPaymentSource: v.optional(v.union(v.literal('apple'), v.literal('superwall'))),
    superwallSequence: v.optional(v.number()), source: v.union(v.literal('apple'), v.literal('superwall')), updatedAt: v.number(),
  }).index('by_transaction', ['transactionId']).index('by_original', ['originalTransactionId']).index('by_owner_access', ['ownerId', 'accessUntil']),
  appleBillingEvents: defineTable({ source: v.union(v.literal('apple'), v.literal('superwall')), eventId: v.string(), transactionId: v.string(), receivedAt: v.number() }).index('by_source_event', ['source', 'eventId']),
  timelineShares:defineTable({projectId:v.id('projects'),ownerId:v.string(),title:v.string(),timeline:timelineValidator,openTimelineId:v.optional(v.string()),tabCount:v.optional(v.number()),chat:v.optional(v.array(sharedChatMessage)),published:v.boolean(),cardTitle:v.optional(v.string()),cardImage:v.optional(v.string()),cardStorageId:v.optional(v.id('_storage')),cardUpdatedAt:v.optional(v.number()),createdAt:v.number(),updatedAt:v.number()}).index('by_project',['projectId']),
  // Extra tabs of a multi-tab share; the share row keeps the first tab as `timeline` for older links.
  shareTimelines:defineTable({shareId:v.id('timelineShares'),timelineId:v.string(),name:v.string(),position:v.number(),timeline:timelineValidator}).index('by_share',['shareId','position']),
  shareAssets:defineTable({shareId:v.id('timelineShares'),...sharedAssetFields}).index('by_share',['shareId']).index('by_storageId',['storageId']).index('by_r2Key',['r2Key']).index('by_previewR2Key',['previewR2Key']).index('by_owner_previewR2Key',['ownerId','previewR2Key']).index('by_thumbnailStorageId',['thumbnailStorageId']).index('by_owner_r2Key',['ownerId','r2Key']).index('by_owner_storageId',['ownerId','storageId']).index('by_owner_thumbnail',['ownerId','thumbnailStorageId']),
  billingCheckouts: defineTable({ ownerId: v.string(), priceId: v.string(), origin: v.string(), trialEligible: v.boolean(), requestId: v.string(), createdAt: v.number(), sessionId: v.optional(v.string()), url: v.optional(v.string()), expiresAt: v.optional(v.number()) }).index('by_owner', ['ownerId']),
  billingSubscriptionSync: defineTable({ stripeSubscriptionId: v.string(), token: v.string(), lastEventId: v.optional(v.string()) }).index('by_subscription', ['stripeSubscriptionId']),
  discordAlerts: defineTable({ ...alertFields, status: v.union(v.literal('queued'), v.literal('delivering'), v.literal('sent'), v.literal('failed')), attempts: v.number(), leaseUntil: v.optional(v.number()), lastError: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number() }).index('by_source_event', ['source', 'eventId']).index('by_status_updated', ['status', 'updatedAt']),
  assistantMessageViews: defineTable({ messageId: v.string(), threadId: v.string(), order: v.number(), stepOrder: v.number(), status: vMessageStatus, version: v.number(), value: vMessageDoc }).index('by_message', ['messageId']).index('by_thread_order', ['threadId', 'order', 'stepOrder']).index('by_thread_status', ['threadId', 'status']),
  assistantMessageThreads: defineTable({ threadId: v.string(), cursor: v.union(v.string(), v.null()), completed: v.boolean() }).index('by_thread', ['threadId']).index('by_completed', ['completed']),
  assistantDisplayFiles: defineTable({ threadId: v.string(), storageIds: v.array(v.id('_storage')) }).index('by_thread', ['threadId']),
  mediaTaskProgress:defineTable({taskId:v.id('mediaTasks'),projectId:v.id('projects'),createdAt:v.number(),progress:v.number()}).index('by_task',['taskId']).index('by_project',['projectId']).index('by_project_createdAt',['projectId','createdAt']),
  mediaTaskViews: defineTable({ taskId: v.id('mediaTasks'), ownerId: v.string(), projectId: v.id('projects'), createdAt: v.number(), kind: mediaTaskKind, status: mediaTaskStatus, progress: v.number(), attempt: v.number(), error: v.optional(v.string()), assetId: v.optional(v.id('assets')), activity: v.optional(mediaTaskActivity), activityStartedAt: v.optional(v.number()), attemptStartedAt:v.optional(v.number()) }).index('by_task', ['taskId']).index('by_project_createdAt', ['projectId', 'createdAt']),
  mediaTaskSlots: defineTable({ status: v.optional(mediaTaskStatus), ownerId: v.string(), taskId: v.id('mediaTasks'), projectId: v.id('projects'), kind: mediaTaskKind, sourceUrl: v.optional(v.string()), importRange: mediaTaskFields.importRange, sourcesOnly: mediaTaskFields.sourcesOnly }).index('by_owner', ['ownerId']).index('by_task', ['taskId']).index('by_project_kind', ['projectId', 'kind']).index('by_import', ['projectId', 'kind', 'sourceUrl', 'importRange.start', 'importRange.end']).index('by_owner_status_kind', ['ownerId', 'status', 'kind']),
  mediaCapacityOwners: defineTable({ ownerId: v.string(), schedulingVersion: v.optional(v.number()), admissionScheduled: v.optional(v.boolean()) }).index('by_owner', ['ownerId']),
  sceneThumbnails: defineTable({ projectId: v.id('projects'), ownerId: v.string(), clipId: v.string(), key: v.string(), snapshotId: v.id('frameSnapshots'), taskId: v.optional(v.id('mediaTasks')), status: v.union(v.literal('queued'), v.literal('completed'), v.literal('failed')), createdAt: v.number(), frames: v.optional(v.array(v.object({ time: v.number(), storageId: v.id('_storage') }))) }).index('by_project_key', ['projectId', 'key', 'createdAt']).index('by_project_clip_status', ['projectId', 'clipId', 'status', 'createdAt']).index('by_snapshot', ['snapshotId']).index('by_project', ['projectId']).index('by_status', ['status']),
  mediaTasks: defineTable(mediaTaskFields).index('by_status_createdAt', ['status', 'createdAt']).index('by_status_claimable_created',['status','claimable','createdAt']).index('by_status_claimable_kind_created',['status','claimable','kind','createdAt']).index('by_status_updated',['status','updatedAt']).index('by_asset_kind', ['assetId', 'kind']).index('by_project_createdAt', ['projectId', 'createdAt']).index('by_project_kind_status',['projectId','kind','status']).index('by_owner_status',['ownerId','status']).index('by_owner_capacity_waiting', ['ownerId', 'capacityWaiting', 'createdAt']).index('by_owner_capacity_queue_status', ['ownerId', 'capacityQueued', 'status', 'createdAt']),
  // Worker dispatch mutexes; retain the persisted table name to preserve in-flight locks.
  flyDispatchLocks: defineTable({ name: v.string(), lockedUntil: v.number(), pending: v.boolean() }).index('by_name', ['name']),
  accountRateLimits:defineTable({ownerId:v.string(),name:v.string(),period:v.number(),windowStart:v.number(),count:v.number()}).index('by_owner_name_period',['ownerId','name','period']),
  // One measure, compare or render request for the blueprint tools, done by the media worker.
  blueprintChecks: defineTable({ ownerId: v.string(), projectId: v.id("projects"), kitId: v.id("brandKits"), mode: v.union(v.literal("measure"), v.literal("compare"), v.literal("render")), screen: v.optional(v.string()), code: v.optional(v.string()), width: v.number(), height: v.number(), points: v.optional(v.array(blueprintPointValidator)), lines: v.optional(v.array(blueprintLineValidator)), status: v.union(v.literal("queued"), v.literal("completed"), v.literal("failed")), result: v.optional(blueprintCheckResultValidator), error: v.optional(v.string()), taskId: v.optional(v.id("mediaTasks")), createdAt: v.number() }).index("by_owner", ["ownerId"]),
  // A brand's UI rebuilt from one of its kit screens: scene code with named parts, scored against the screen.
  blueprints: defineTable({ ownerId: v.string(), kitId: v.id("brandKits"), name: v.string(), screen: v.string(), code: v.string(), width: v.number(), height: v.number(), parts: v.array(blueprintPartValidator), checks: v.array(blueprintCheckValidator), colors: v.array(v.object({ label: v.string(), hex: v.string(), x: v.number(), y: v.number() })), edges: v.array(v.object({ label: v.string(), axis: v.union(v.literal("x"), v.literal("y")), at: v.number() })), createdAt: v.number(), updatedAt: v.number() }).index("by_kit_name", ["kitId", "name"]).index("by_owner", ["ownerId"]),
  brandKits: defineTable({ ownerId: v.string(), name: v.string(), sourceUrl: v.optional(v.string()), colors: v.array(brandColorValidator), fonts: v.array(v.object({ family: v.string(), weight: v.string(), role: v.union(v.literal('heading'), v.literal('body'), v.literal('other')), storageId: v.id('_storage') })), logo: v.optional(v.string()), copy: v.optional(v.object({ title: v.optional(v.string()), description: v.optional(v.string()), headings: v.array(v.string()) })), context: v.optional(brandContextValidator), screens: v.optional(v.array(brandScreenValidator)), createdAt: v.number(), updatedAt: v.number() }).index('by_ownerId_name', ['ownerId', 'name']),
  users: defineTable(userFields).index("by_clerk_id", ["clerkId"]),
  projects: defineTable(projectFields).index("by_ownerId_updatedAt", ["ownerId", "updatedAt"]),
  previewSegments: defineTable({assetId:v.id('assets'),ownerId:v.string(),r2Key:v.string(),start:v.number(),end:v.number(),size:v.number(),version:v.number()}).index('by_asset',['assetId']).index('by_r2Key',['r2Key']).index('by_owner_r2Key',['ownerId','r2Key']),
  assets: defineTable(assetFields).index('by_project_import',['projectId','importSourceUrl','importRange.start','importRange.end']).index("by_analysis",["analysisId"]).index("by_ownerId_projectId", ["ownerId", "projectId"]).index('by_owner_project_r2Key',['ownerId','projectId','r2Key']).index("by_ownerId_createdAt", ["ownerId", "createdAt"]).index("by_storageId", ["storageId"]).index("by_r2Key", ["r2Key"]).index('by_previewR2Key',['previewR2Key']).index('by_owner_previewR2Key',['ownerId','previewR2Key']).index('by_thumbnailStorageId',['thumbnailStorageId']).index('by_owner_r2Key',['ownerId','r2Key']).index('by_owner_storageId',['ownerId','storageId']).index('by_owner_thumbnail',['ownerId','thumbnailStorageId']).index('by_owner_audio',['ownerId','audioAssetId']),
  // The timeline an export renders, apart from its job so listing exports never reads whole timelines.
  renderSnapshots: defineTable({ jobId: v.id('renderJobs'), timeline: timelineValidator }).index('by_job', ['jobId']),
  renderJobs: defineTable(renderFields).index("by_ownerId_projectId", ["ownerId", "projectId"]).index("by_status_createdAt", ["status", "createdAt"]).index("by_owner_project_status",["ownerId","projectId","status"]).index('by_owner_status',['ownerId','status']),
  analysisRequests: defineTable(analysisRequestFields).index("by_projectId_runId", ["projectId", "aiRunId"]).index("by_projectId", ["projectId"]),
  r2Uploads: defineTable(r2UploadFields).index("by_projectId", ["projectId"]).index("by_projectId_completed", ["projectId", "completed"]).index('by_owner_completed',['ownerId','completed']),
  uploadTickets: defineTable({
    token: v.string(), ownerId: v.string(), projectId: v.id("projects"), jobId: v.optional(v.id("renderJobs")),
    storageId: v.optional(v.id("_storage")), expiresAt: v.number(), consumed: v.boolean(), receiving: v.optional(v.boolean()),
  }).index("by_token", ["token"]).index("by_storageId", ["storageId"]).index("by_projectId", ["projectId"]),
  // MCP: OAuth clients registered dynamically (RFC 7591), one-time authorization
  // codes, and hashed bearer tokens. Token values are never stored.
  editingLaneTabs: defineTable({ownerId:v.string(),projectId:v.id('projects'),timelineId:v.string(),lane:laneValidator,manual:v.boolean(),reason:v.string()}).index('by_project_tab',['projectId','timelineId']).index('by_project',['projectId']),
  editingLaneTasks: defineTable({ownerId:v.string(),projectId:v.id('projects'),taskId:v.string(),lane:laneValidator,capabilities:v.optional(v.array(v.string())),laneChosen:v.optional(v.boolean()),manual:v.optional(v.boolean()),lockedLane:v.optional(laneValidator),attempts:v.number(),exportConfirmed:v.optional(v.boolean()),checkLevel:v.optional(v.literal('final')),required:v.boolean(),initialTabIds:v.array(v.string()),baselines:v.array(laneBaselineValidator),evidence:v.array(laneEvidenceValidator),result:v.optional(laneResultValidator),createdAt:v.number()}).index('by_task',['taskId']).index('by_project',['projectId']),
  mcpConnections: defineTable({ownerId:v.string(),connectionId:v.string(),agentName:v.string(),clientInfo:v.object({name:v.string(),title:v.optional(v.string()),version:v.string()}),closedAt:v.optional(v.number())}).index('by_connection',['ownerId','connectionId']),
  mcpLaneSessions: defineTable({ownerId:v.string(),connectionId:v.string(),projectId:v.id('projects'),timelineId:v.string(),taskId:v.string(),lane:laneValidator,laneChosen:v.optional(v.boolean()),agentName:v.optional(v.string()),agentClientId:v.optional(v.id('mcpConnections')),activeUntil:v.optional(v.number()),agentEndedAt:v.optional(v.number())}).index('by_connection',['ownerId','connectionId']).index('by_connection_target',['ownerId','connectionId','projectId','timelineId']).index('by_task',['taskId']).index('by_project',['projectId']).index('by_project_activity',['projectId','activeUntil']).index('by_connection_activity',['ownerId','connectionId','activeUntil']),
  mcpClients: defineTable({ clientId: v.string(), clientName: v.string(), redirectUris: v.array(v.string()), createdAt: v.number() }).index("by_clientId", ["clientId"]).index("by_createdAt", ["createdAt"]),
  // A redeemed code stays as a tombstone naming its grant, so a replayed code can revoke it.
  mcpAuthCodes: defineTable({ codeHash: v.string(), clientId: v.string(), ownerId: v.string(), redirectUri: v.string(), codeChallenge: v.string(), resource: v.optional(v.string()), expiresAt: v.number(), redeemedGrantId: v.optional(v.string()) }).index("by_codeHash", ["codeHash"]).index("by_expiresAt", ["expiresAt"]),
  mcpTokens: defineTable({
    tokenHash: v.string(), kind: v.union(v.literal("access"), v.literal("refresh"), v.literal("personal"), v.literal("grant")), ownerId: v.string(),
    // One connection (an approved client, or one personal token) shares a grant. A "grant" row is the Convex half of a
    // connection approved through the Cloudflare MCP server's OAuth provider: its key is held only by that Worker.
    grantId: v.string(), clientId: v.optional(v.string()), label: v.string(),
    createdAt: v.number(), expiresAt: v.optional(v.number()), lastUsedAt: v.optional(v.number()), revokedAt: v.optional(v.number()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_owner", ["ownerId"]).index("by_owner_revoked", ["ownerId", "revokedAt"]).index("by_grant", ["grantId"]).index("by_grant_revoked", ["grantId", "revokedAt"]).index("by_clientId", ["clientId"]).index("by_revokedAt", ["revokedAt"]),
  // Background removal for one clip's source range, run by fal.ai through the media worker.
  cutouts: defineTable({ ownerId: v.string(), projectId: v.id("projects"), clipId: v.string(), sourceAssetId: v.id("assets"), start: v.number(), end: v.number(), selection: v.optional(subjectSelectionValidator), fps: v.optional(v.number()), mode: v.optional(v.union(v.literal('person'),v.literal('foreground'))), subject: v.optional(v.string()), effect: v.optional(cutoutEffectValidator), status: v.union(v.literal("queued"), v.literal("completed"), v.literal("failed")), taskId: v.optional(v.id("mediaTasks")), outputAssetId: v.optional(v.id("assets")), placed: v.optional(v.boolean()), error: v.optional(v.string()), createdAt: v.number() }).index("by_project", ["projectId"]),
  // Processed copies of one clip's source made by the media worker: a freeze-frame still, smooth slow motion
  // (fal.ai RIFE frame interpolation) or an upscale. `factor` is the frame multiplier, `scale` the upscale.
  derivations: defineTable({ ownerId: v.string(), projectId: v.id("projects"), clipId: v.string(), sourceAssetId: v.id("assets"), op: v.union(v.literal("freeze"), v.literal("slowmo"), v.literal("upscale"), v.literal("stats"), v.literal("parallax"), v.literal("pixelTrack")), trackingToken: v.optional(v.string()), trackingAttempt: v.optional(v.number()), trackingHeader: v.optional(pixelTrackHeaderValidator), trackingCount: v.optional(v.number()), tracking: v.optional(pixelTrackRequestValidator), pixelTrack: v.optional(pixelTrackResultValidator), start: v.number(), end: v.number(), selection: v.optional(subjectSelectionValidator), backgroundPrompt: v.optional(v.string()), time: v.optional(v.number()), times: v.optional(v.array(v.number())), stats: v.optional(v.array(v.any())), factor: v.optional(v.number()), scale: v.optional(v.number()), target: v.optional(v.number()), placeLater: v.optional(v.boolean()), status: v.union(v.literal("queued"), v.literal("completed"), v.literal("failed")), taskId: v.optional(v.id("mediaTasks")), outputAssetId: v.optional(v.id("assets")), placed: v.optional(v.boolean()), error: v.optional(v.string()), createdAt: v.number() }).index("by_project", ["projectId"]).index("by_source_op", ["sourceAssetId", "op"]),
  pixelTrackChunks: defineTable({ ownerId: v.string(), projectId: v.id('projects'), derivationId: v.id('derivations'), attempt: v.number(), direction: v.union(v.literal('forward'), v.literal('backward')), sequence: v.number(), start: v.number(), end: v.number(), samples: v.array(pixelTrackSampleValidator) }).index('by_project', ['projectId']).index('by_track_attempt_start', ['derivationId', 'attempt', 'start']).index('by_track_attempt_sequence', ['derivationId', 'attempt', 'direction', 'sequence']),
  // What the editing AI remembers: lasting preferences and facts, for the user or one project.
  agentMemories: defineTable({ ownerId: v.string(), projectId: v.optional(v.id("projects")), kind: v.optional(v.union(v.literal("preference"), v.literal("style"))), topic: v.optional(v.union(v.literal("captions"), v.literal("platforms"), v.literal("editing"))), name: v.optional(v.string()), text: v.string(), recipe: v.optional(v.string()), sourceProjectId: v.optional(v.id("projects")), uses: v.optional(v.number()), lastUsedAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number() }).index("by_owner_project", ["ownerId", "projectId"]),
  // findIcon's fetched logos and icons with their preview (convex/icons.ts).
  iconCache: defineTable({ key: v.string(), value: v.string(), fetchedAt: v.number() }).index('by_key', ['key']),
  // Successful motion reads and honest exceptions survive turns; exceptions never certify a match.
  referenceMotionCoverage: defineTable({ ownerId: v.string(), projectId: v.id('projects'), assetId: v.id('assets'), windows: v.array(v.object({ start: v.number(), end: v.number() })) }).index('by_project_asset', ['projectId', 'assetId']).index('by_project', ['projectId']),
  referenceMotionOff: defineTable({ ownerId: v.string(), projectId: v.id('projects'), timelineId: v.string(), assetId: v.id('assets'), start: v.number(), end: v.number(), time: v.number(), reason: v.string() }).index('by_project_timeline_asset', ['projectId', 'timelineId', 'assetId']).index('by_project', ['projectId']),
  referenceMotionChecks: defineTable({ ownerId: v.string(), projectId: v.id('projects'), timelineId: v.string(), assetId: v.id('assets'), start: v.number(), end: v.number(), timelineStart: v.number(), revision: v.number(), timelineKey: v.string(), scope: v.string(), checkedAt: v.number(), differences: v.array(v.object({ time: v.number(), issue: v.string(), fix: v.optional(v.string()) })) }).index('by_window', ['projectId', 'timelineId', 'assetId', 'start', 'end', 'scope']).index('by_project_timeline_asset', ['projectId', 'timelineId', 'assetId']).index('by_project', ['projectId']),
  // A reading of a source video for the agent: a sheet of frames, or an object tracked frame by frame.
  mediaFrameCache: defineTable({ key: v.string(), r2Key: v.string(), ownerId: v.string(), projectId: v.id('projects'), assetId: v.optional(v.id('assets')), expiresAt: v.optional(v.number()), ready: v.boolean(), timeline: v.optional(v.boolean()), taskId: v.optional(v.id('mediaTasks')), leaseToken: v.optional(v.string()) }).index('by_key', ['key']).index('by_asset', ['assetId']).index('by_project', ['projectId']).index('by_expiry', ['expiresAt']).index('by_project_timeline', ['projectId','timeline']),
  comparisonContinuations: defineTable({ownerId:v.string(),projectId:v.id('projects'),timelineId:v.string(),binding:v.string(),state:v.string(),createdAt:v.number()}).index('by_project',['projectId']),
  referenceReads: defineTable({ projectId: v.id('projects'), ownerId: v.string(), assetId: v.id('assets'), recreation: v.optional(v.boolean()), mode: referenceReadMode, color: v.optional(v.string()), tolerance: v.optional(v.number()), text: v.optional(v.string()), categories: v.optional(v.array(v.string())), start: v.number(), end: v.number(), times: v.optional(v.array(v.number())), snapshotId: v.optional(v.id('frameSnapshots')), compareCrop: v.optional(referenceBox), referenceCropKeyframes: v.optional(referenceCropKeyframesValidator), count: v.optional(v.number()), fps: v.optional(v.number()), momentsOnly: v.optional(v.boolean()), stillsOnly: v.optional(v.boolean()), crop: v.optional(referenceBox), box: v.optional(referenceBox), frameTime: v.optional(v.number()), backgroundTime: v.optional(v.number()), points: v.optional(v.array(v.object({ x: v.number(), y: v.number(), label: v.optional(v.string()) }))), lines: v.optional(v.array(v.object({ axis: v.union(v.literal('x'), v.literal('y')), at: v.number(), from: v.number(), to: v.number(), label: v.optional(v.string()) }))), status: v.union(v.literal('queued'), v.literal('completed'), v.literal('failed')), result: v.optional(referenceReadResult), resultStorageId: v.optional(v.id('_storage')), error: v.optional(v.string()), taskId: v.optional(v.id('mediaTasks')), createdAt: v.number() }).index('by_project', ['projectId']),
  // Rendered timeline frames an MCP client asked to see; deleted once read.
  frameSnapshotControls: defineTable({snapshotId:v.id('frameSnapshots'),projectId:v.id('projects'),preserve:v.boolean(),cancelTaskId:v.optional(v.id('mediaTasks'))}).index('by_snapshot',['snapshotId']).index('by_project',['projectId']),
  frameSnapshotPayloads: defineTable({snapshotId:v.id('frameSnapshots'),projectId:v.id('projects'),timeline:timelineValidator}).index('by_snapshot',['snapshotId']).index('by_project',['projectId']),
  frameSnapshots: defineTable({resolution:v.optional(frameResolution),clipCheck:v.optional(clipCheckRequestValidator),clipCheckResult:v.optional(v.string()),cacheIdentity:v.optional(v.string()),resultR2Key:v.optional(v.string()),normalization:v.optional(normalizationRequestValidator),normalizationResult:v.optional(normalizationResultValidator), sourceTimeline: v.optional(timelineValidator), comparison: v.optional(v.object({ crop: v.optional(referenceBox), aspectRatio: v.optional(v.number()) })), projectId: v.id("projects"), ownerId: v.string(), runId: v.optional(v.string()), revision: v.number(), times: v.array(v.number()), taskId: v.optional(v.id("mediaTasks")), status: v.union(v.literal("queued"), v.literal("completed"), v.literal("failed")), frames: v.optional(v.array(v.object({ time: v.number(), image: v.string(), width:v.optional(v.number()), height:v.optional(v.number()) }))), error: v.optional(v.string()), createdAt: v.number(), clipId: v.optional(v.string()), key: v.optional(v.string()), timelineId: v.optional(v.string()), shareId: v.optional(v.id('timelineShares')), pacing: v.optional(pacingRequestValidator), pacingResult: v.optional(pacingResultValidator), motion: v.optional(v.object({ start: v.number(), end: v.number() })), motionKey:v.optional(v.string()), motionResult: v.optional(v.any()), sound: v.optional(soundRequestValidator), soundResult: v.optional(soundResultValidator), atRevision: v.optional(v.number()), guard: v.optional(v.object({ baseline: timelineValidator, candidate: timelineValidator })), differences: v.optional(v.array(v.number())) }).index("by_project", ["projectId"]).index("by_project_key", ["projectId", "key"]).index("by_project_clip", ["projectId", "clipId"]),
  // Per-minute counters keyed by owner (tool calls) or "register:<ip>" (client registration).
  // The project's living brief: the user's lasting direction for this project, one rule each with the words they said it in.
  projectBriefs: defineTable({ projectId: v.id('projects'), ownerId: v.string(), rules: v.array(v.object({ id: v.string(), rule: v.string(), words: v.string(), at: v.number() })), updatedAt: v.number() }).index('by_project', ['projectId']),
  mcpUsage: defineTable({ ownerId: v.string(), windowStart: v.number(), calls: v.number() }).index("by_owner", ["ownerId"]),
});
