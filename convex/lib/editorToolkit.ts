import { retryAbortedTransaction } from './retry_aborted_transaction';
import { materializeTranscript } from '../../lib/media-analysis/transcript';
import { forEachLimited } from '../../lib/server/run-limited';
import { LANES, MCP_ONLY_TOOLS, capabilityExists, capabilitySummary, discoverCapabilities, laneToolAllowed, laneToolError, laneSkill, laneInstructions, type LaneId } from '../../lib/ai/lanes';
import { getLayerDescription, getLayerInput, segmentDescription, segmentInput, subjectSeed } from '../../lib/ai/lanes/genesis/functions/segment';
import { applyLayerEffect, layerEffectDescription, layerEffectInput } from '../../lib/ai/lanes/genesis/functions/layer-effect';
import { applyTextBehind, textBehindDescription, textBehindInput } from '../../lib/ai/lanes/genesis/functions/text-behind';
import type { Applied } from '../../lib/ai/lanes/genesis/functions/layer';
import { applyJobDescription, applyJobInput, depthDescription, depthEffectDescription, depthEffectInput, depthInput, effectLayers, effectParams, getJobDescription, getJobInput } from '../../lib/ai/lanes/genesis/functions/depth';
import { relightDescription, relightInput } from '../../lib/ai/lanes/genesis/functions/relight';
import { lightPlan } from '../../lib/ai/lanes/genesis/functions/light';
import { DEPTH_MODEL, EXPLICIT_LIGHT_MODE } from '../../lib/ai/lanes/genesis/config';
import type { RelightParams } from '../../lib/ai/lanes/genesis/job';
import { LANE_IDS } from '../../lib/ai/lanes/types';
import { timelineHistoryKey } from '../../lib/editor/timeline-history-key';
import { laneBaseline } from '../../lib/ai/lanes/task';
import { exhaustedLaneError, finishLane, type FinishResult } from './laneFinish';
import type { EditorRun, LaneTask } from './run_types';
import { snapshotFrames } from '../../lib/ai/snapshot-frames';
import { impactSettingsSchema, overlaySettingsSchema, parallaxSettingsSchema, DEFAULT_IMPACT, DEFAULT_OVERLAY, DEFAULT_PARALLAX, vfxDuration } from '../../lib/editor/montage-vfx';
import { generateImagePlates, imageGenerationInput, imageGenerationQuality, imageGenerationSize, IMAGE_MODEL } from '../../lib/ai/image-generation';
import { generatedImageSummary } from './generated_image_summary';
import { pixelTrackRequest, trackSeed, type PixelTrackRequest } from '../../lib/media-analysis/pixel-track';
import { audioNormalizationKey, timelineNormalizationKey } from '../../lib/editor/audio-normalization';
import { sourceType, semanticMoment } from '../../lib/media-analysis/highlights';
import { clipCheckResult } from '../../lib/media-analysis/clip-check';
import { completionRepairFeedback } from '../../lib/ai/tool-failures';
import { BOUNDED_READ_REFUSAL, FULL_CHECK_TOOLS, checkInstructions, fullCheckRefusal, laneChecks, tracksChangedFrames } from '../../lib/ai/lanes/checks';
import type { CheckLevel } from '../../lib/ai/lanes/types';
import { captionSyncFailures, retainedSpeechWords } from '../../lib/ai/lanes/reel/check';
import { FastFrameReview, fastReelFrameMoments, readFastFrameTimes, fastFrameEvidence } from '../../lib/ai/fast-frame-review';
import { effectPlanInput,validateEffectPlan,mergeEffectPlans,effectReviewBindings,type EffectPlan,type EffectEvidence } from '../../lib/ai/edit-plan';
import { equalTimelineValue } from '../../lib/editor/timeline-equality';
import { applyTwoRowLayout } from '../../lib/editor/two-row-layout';
import { applyMirrorBlurLayout } from '../../lib/editor/mirror-blur-layout';
import { SPEAKER_ANALYSIS_VERSION, summarizeSpeakerFraming, type SpeakerAnalysis } from '../../lib/media-analysis/clipping';
import {configureSmoothZoomPatch,rememberZoomTargets,type ZoomTargetEvidence} from '../../lib/ai/zoom-targets';
import {configureCameraMotionPatch} from '../../lib/ai/camera-targets';
import {textGradientPatch} from '../../lib/editor/text-gradient';
import {animateObjects} from '../../lib/editor/object-motion';
import {EFFECT_KEYFRAME_CONTROLS,effectKeyframesPatch} from '../../lib/editor/effect-keyframes';
import {MOTION_EASINGS} from '../../lib/editor/motion-path';
import {SPEED_RAMP_PRESET_IDS,presetAnchors,type SpeedRampPreset} from '../../lib/editor/speed-ramp';
import {bakeMaskAnchors} from '../../lib/editor/masks';
import {attachMaskPatch,attachOverlayPatch,pointsToSamples,streamedAttachmentPatch} from '../../lib/editor/tracking-attach';
import {CAMERA_ZOOM_RANGE,SMOOTH_ZOOM_EASINGS} from '../../lib/editor/smooth-zoom-settings';
import { modelTimeline, modelAssetAnalysis, modelAssetAnalysisWindows, OPTIONAL_UNDERSTANDING_NOTE } from "../../lib/ai/editor-context";
import { closeFootageGaps } from "../../lib/editor/close-gaps";
import { createTool, storeFile } from "@convex-dev/agent";
import { z } from "zod";
import { components, internal } from "../_generated/api";
import type { Doc,Id } from "../_generated/dataModel";
import type { Clip, PixelTrackReference, Timeline } from "../../lib/editor/types";
import { alignCutsToBeats } from "../../lib/editor/beat-cuts";
import { addBeatMarkers } from "../../lib/editor/beat-markers";
import { addTimelineMarker,moveTimelineMarker,removeTimelineMarker, removeTimelineMarkers, sectionMarkersIn } from "../../lib/editor/timeline-markers";
import { AUDIO_ROLES, BLEND_MODES, IRIS_SHAPES, MASK_SHAPES, TRANSITION_DIRECTIONS, TRANSITION_PRESETS, WHIP_BLUR_MAX, WHIP_DIRECTIONS, WHIP_FRAMES, WHIP_TRAVEL, WIPE_DIRECTIONS, dimensions, deriveTrackCounts, deriveTracks, maxTrackCount, timelineDuration, trackOf } from "../../lib/editor/types";
import {VISUAL_INPUT_UNITS,VISUAL_TRANSFORM_LIMITS,transformInputPatch,cropInputPatch} from '../../lib/editor/visual-inputs';
import { addMediaClip, addEffectClip, convertSolidColorToVisual, setClipPlaybackRate, setClipSpeedRamp, deleteClip, focusForClip, newLayerOverlaps, patchClip, placeOnFreeLayer, splitClip,trimClip,unlinkClips,setClipBlendMode, addTransitionClip } from "../../lib/editor/operations";
import { TimelineGestureRejection } from '../../lib/editor/timeline-edit-errors';
import { APPROVAL_NOTE_LIMIT, approvalRefusal, approvalViolations, approveClip, approveSection, approvedWork, checkFilmSections, checkSectionCalls, isApproved, markerSection, unapproveClip, type ApprovalViolation } from '../../lib/editor/approvals';
import { summarizeTimeline } from "./inspectTimeline";
import { EditSession } from "./editSession";
import { EDITOR_TOOL_DEFINITIONS, assertToolDefinitions, toolBehavior } from '../../lib/ai/tool-definitions';
import type { JSONValue } from 'ai';
import { BACKGROUND_ACCENTS, BACKGROUND_STRUCTURES, candidateDocument, kitRoles, resolveCandidate, type BackgroundBoard } from '../../lib/editor/background-preview';
import { ToolSaveReceipts } from './toolSaveReceipts';
import { needsSaveConfirmation, hasSaveEvidence, toolSaveReceipt } from '../../lib/ai/save-confirmation';
import { incidentShape } from './save_incidents';
import { boundRunTab, isMcpRun } from "./run_ids";
import { MCP_WORKER_WAIT_MS } from "./mcp_limits";
import type { PacingResult } from "../../lib/media-analysis/pacing";
import type { SoundResult } from "../../lib/media-analysis/sound";
import { placeClip, TIMELINE_ROW } from "./revision_log";
import { READ_TOOL_DESCRIPTIONS, READ_TOOL_INPUTS, readSummary, runRead, type ReadToolName } from "./reference_reads";
import { ZOOM_LIMITS, isZoomPreset, EFFECT_CATALOG,SOLID_COLOR_LIMITS, OFFERED_TIMED_EFFECT_PRESETS,configureTimedEffectPatch, solidColorPatch } from '../../lib/editor/clip-effects';
import { PUNCH_LIMITS } from '../../lib/editor/motion-effect-settings';
import { SCENE_BLUEPRINT_LIMIT, SCENE_LIMITS } from '../../lib/editor/scene-layers';
import { checkSceneCode } from '../../lib/editor/scene-compile';
import { placeFilm, syncFilmSectionMarkers, withPatchedScene, type SceneEdit, type SectionMarkerChanges } from '../../lib/editor/scene-film';
import { cutDraftSnippet, cutFilmDraft, draftSections, type DraftSection } from '../../lib/editor/film-draft';
import { clipBeats, newFilmBeats, resolveBeatTiming, type ResolvedTiming } from '../../lib/editor/beat-timing';
import { filmDraftPublisher, DRAFT_TOOLS, type BuildFilmDraft } from './filmDraftStream';
import { inspectSceneCode, patchSceneCode, rebaseSceneCode, sceneCodeSource, searchSceneCode, type SceneLineEdit } from '../../lib/editor/scene-code-edits';
import { sectionCount, sectionRanges, guardedSections, guardTimes, resolveScope, restoreSectionCode, type ScopeInput } from '../../lib/editor/section-scope';
import { TEXT_EFFECT_PRESETS, TEXT_ANIMATION_PRESETS,TEXT_ANIMATION_LABELS,textAnimationPatch, textEffectPatch, textTemplatePatch } from '../../lib/editor/text-effects';
import { TEXT_LOOKS,textLookPatch } from '../../lib/editor/text-looks';
import { TEXT_FONTS } from '../../lib/editor/text-fonts';
import { applyCaptionStyle,patchCaptionStyles,patchTextStyles,updateCaptionTiming } from '../../lib/editor/caption-editing';
import { captionClipsFromTranscript, captionsCoverTranscript } from '../../lib/editor/transcript-captions';
import { AUDIO_LIMITS,audioSettings,audioSettingsPatch,configureAudio } from '../../lib/editor/audio-settings';
import { STOCK_AUDIO_IDS,isStockAudioKey,stockAudio } from '../../lib/editor/stock-audio';
import { generateSoundEffect, soundEffectInput, type SoundEffectRequest } from '../../lib/audio/sound-effect';
import { NARRATION_VOICES, VOICE_LIMITS, generateNarration, generateVoiceSample, voiceInput } from '../../lib/audio/voice';
import { BRAND_LIMITS } from '../../lib/editor/brand-kit';
import { cleanColors, googleFonts, sceneBrandSnapshot, scrapeBrand } from './brandKitBuild';
import { mediaConfig, mediaUrl, newProjectMediaKey } from './media_storage';
import { encodeWav, soundWaveform } from '../../lib/audio/wav';
import { SR } from '../../lib/audio/dsp';
import { MUSIC_BED_LIMITS, renderMusicBed } from '../../lib/audio/music-bed';
import { beatGrid, energyCurve, feelOf, momentFit, phaseForMoments, placeStockMusic, rankStockMusic } from '../../lib/audio/music-match';
import { MIXKIT_LICENSE, MIXKIT_REFERER, stockMusicFileName } from '../../lib/editor/stock-music';
import { putMediaObject, storageControl } from './media_storage';
import {configureVisualFade,VISUAL_FADE_MAX_SECONDS} from '../../lib/editor/visual-fades';
import { OFFERED_VISUAL_EFFECT_GROUPS,visualEffectActionPatch } from '../../lib/editor/visual-effect-actions';
import { VISUAL_EFFECT_LIMITS, visualEffectsPatch } from '../../lib/editor/visual-effects';
import { deleteEmptyLayer, removeEmptyLayers,reorderLayer,moveSelectedClips,moveClipTo,resizeSelectedClips } from '../../lib/editor/timeline-controls';
import {copyTimelineClips,pasteTimelineClips} from '../../lib/editor/clipboard';
import { MAX_INSPECTION_QUESTION, validateVideoInspectionInput, videoMatchesOnClip, type VideoInspectionInput } from '../../lib/media-analysis/video-inspection';
import { TRANSCRIPT_VERSION, currentTranscript, transcriptFromWords } from '../../lib/media-analysis/transcript';
import { frameEvidenceOnClip, frameInspectionCoverage, assertConsecutiveInspection, validateFrameInspectionInput, type FrameInspectionInput } from '../../lib/media-analysis/frame-inspection';
import { shotAlignedRange } from '../../lib/media-analysis/shots';
import { REFERENCE_PARTS, readReference, referenceMoments, referenceOutline } from '../../lib/media-analysis/reference';
import { playbackRateOf, sourceEndOf, sourceTimeAt, timelineTimeAtSource } from '../../lib/editor/playback-rate';
import { CSS_REACTIVE_TARGETS, MAX_REACTIVE_SAMPLES, REACTIVE_RATE, decodeLevels, encodeLevels, energyLevels, pulseLevels, reactiveAmountRange } from '../../lib/editor/audio-reactive';
import { HSL_BANDS, LUT_LOOKS, MAX_TIMELINE_LUTS, parseCube, type HslAdjust } from '../../lib/editor/color-finish';
import { describeColor, matchCurves, type ColorStats } from '../../lib/editor/color-match';
import { FREEZE_MODES, MAX_FREEZE_SECONDS, MIN_FREEZE_SECONDS, insertFreezeFrame } from '../../lib/editor/freeze-frame';
import { retainSourceRanges, type RetainedRangeSummary } from '../../lib/editor/retained-ranges';
import { currentSpeechCleanup, keptRanges, snapToSpeech } from '../../lib/speech-cleanup';
import { applySplitEdit, MAX_SPLIT_EDIT_SECONDS } from '../../lib/editor/split-edits';
import type { CleanupCut } from '../../lib/speech-cleanup/types';
import { AUDIO_ACTIVITY_VERSION, AUDIO_QUIET_EDGE_PAD, refineAudioRangeEdges, refineTranscriptWithAudioActivity } from '../../lib/media-analysis/audio-activity';
import { TEXT_TEMPLATE_PRESETS } from '../../lib/editor/text-templates';
import { DEFAULT_CAPTION_STYLE, resolvedTextAppearance, TEXT_APPEARANCE_LIMITS, TEXT_TYPOGRAPHY_LIMITS } from '../../lib/editor/text-style';
import { BEAT_ANALYSIS_ENGINE } from '../../lib/media-analysis/beat-map';
import { barsForLength, musicStructure, nearestDownbeat } from '../../lib/media-analysis/music-structure';
import { musicEnergy } from '../../lib/media-analysis/sound';
import { CLOSE_UP_FRAMES, ReadCoverage } from '../../lib/ai/read-coverage';
import { runCompare } from './reference_reads';
import { aspectRatio as aspectRatioValidator } from '../schema';
import { comparisonCropFields, referenceCropAt, cropBounds, comparisonSamples, referenceComparisonInput, REFERENCE_COMPARISON_BUDGET_MS, type ComparisonCrop, type ComparisonCrops } from '../../lib/ai/reference-comparison';
import type { MotionMap } from '../../lib/inspo-motion/motion-map';
import { missingMotionWindow, motionRange, motionReport, motionTimelineKey, type MotionOff } from '../../lib/ai/motion-coverage';
import { referenceMotionTargets } from '../../lib/ai/lanes/recreate/motion';
import type { ActionCtx } from "../_generated/server";

export class AnalysisStepError extends Error {}
/** A rendered bed's energy, measured as the worker measures a song, so analyzeMusic keeps its exact beat grid. */
const bedEnergy = (samples: readonly ArrayLike<number>[]) => { const energy = musicEnergy(), interleaved = new Float32Array(samples[0].length * 2); for (let i = 0; i < samples[0].length; i++) { interleaved[2 * i] = samples[0][i]; interleaved[2 * i + 1] = samples[1]?.[i] ?? samples[0][i]; } energy.push(interleaved); return energy.finish(); };
/** Export settings, shared by the in-app and MCP exportVideo tools; startRenderFor checks the plan allows them. */
export const EXPORT_SETTINGS_INPUT = { resolution: z.union([z.literal(720), z.literal(1080), z.literal(2160)]).optional(), fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(), quality: z.enum(['draft', 'standard', 'high']).optional() };
async function reportAnalysisFailure<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) { if (error instanceof AnalysisStepError) return { success: false as const, error: error.message.slice(0, 1000) }; throw error; }
}

type EditorToolkitOptions = {
  run: EditorRun;
  project: Doc<'projects'>;
  /** Shared with the caller; analysis and generated sounds update it in place. */
  assets: Doc<'assets'>[];
  /** A recovering run must inspect the timeline before its first edit. */
  recovering: boolean;
  initialPlans: EffectPlan[];
  selectedClipIds: string[];
  playhead?: number;
  /** The chat turn a destructive replacement is published to, when there is one. */
  publication?: { threadId: string; promptMessageId: string };
  abortSignal: AbortSignal;
  /** MCP includes dispatch time in the comparison's four-minute budget. */
  comparisonDeadline?: number;
  /** MCP clients review their own work (getFrames); effects need no in-turn plan there. */
  planlessEffects?: boolean;
  /** Set by the server from the task's request (lanes.begin); model and reasoning effort never change it. */
  checkLevel?: CheckLevel;
  /** Changed-frame times still to check, carried between runner steps (stored as pendingFastFrames). */
  pendingFastFrames?: number[];
  segment?:number;
  /** Stable editing-lane task identity; MCP calls otherwise have one run each. */
  taskId?:string;
  draft?:Timeline;
  lane?: LaneId;
  finishRequired?:boolean;
  laneChosen?:boolean;
  capabilities?:string[];
};

/** The editor's AI tools bound to one active run: the in-app assistant and MCP share them. */
/** Tool output with labeled images: the text without image data, then each image after its label. */
/** What the agent reads first about a reference: enough to describe it shot by shot and choose what to borrow. */
function referenceSummary(asset: { _id: string; fileName: string; analysis?: { reference?: string } }) {
  const reference = readReference(asset.analysis?.reference);
  if (!reference) throw new Error('The reference breakdown did not save. Analyze this video again.');
  return { assetId: asset._id, fileName: asset.fileName, genre: reference.genre, summary: reference.summary, duration: reference.duration, shotCount: reference.shots.length, rhythm: reference.rhythm, direction: reference.direction, signatures: reference.signatures, shots: referenceOutline(reference),
    // Cuts alone undercount a motion film: moments are every measured change, motion inside a shot too. Read each with readFrames.
    ...(reference.moments ? { momentCount: reference.moments.length, moments: referenceMoments(reference) } : {}), uncertainty: reference.uncertainty };
}

// Chat history keeps every tool result and the chat re-reads its latest page on each new message, so images
// inline in results were read over and over. Store each image as a file and keep only its URL in the result.
async function imagePart(ctx: unknown, data: string, mediaType: string) {
  if (!ctx || typeof ctx !== 'object' || !('storage' in ctx) || !('runMutation' in ctx)) return { type: 'file' as const, data: { type: 'data' as const, data }, mediaType };
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  const { file } = await storeFile(ctx as ActionCtx, components.agent, new Blob([bytes], { type: mediaType }));
  return { type: 'file' as const, data: { type: 'url' as const, url: new URL(file.url) }, mediaType };
}

async function blueprintImages(ctx: unknown, output: unknown) {
  const { images = [], ...rest } = output as { images?: { label: string; data: string; mimeType: string }[] };
  return { type: 'content' as const, value: [{ type: 'text' as const, text: JSON.stringify(rest) }, ...(await Promise.all(images.map(async image => [{ type: 'text' as const, text: image.label }, await imagePart(ctx, image.data, image.mimeType)]))).flat()] };
}

/** The visual guard refuses a locked section whose frame changed in more than this share of its pixels. */
const GUARD_LIMIT = .002;

/** Shown with approved work in inspectTimeline and inspectClip. */
const APPROVED_RULE = 'Approved clips and sections are signed off by the user. Every editing tool refuses to change them. Edit around them; change one only when the user names it, by passing overrideApproved: true with overrideReason quoting the user. Say in the reply that approved work was changed.';
/** Tools that never change clips, so they take no approved-work override. */
const APPROVAL_FREE_TOOLS = new Set(['findHighlights','planClips','checkClip','finishClipping','generateImage', 'listTimelines', 'createTimeline', 'openTimeline', 'importVideoLink', 'getMediaTask', 'exportVideo', 'compareMotion', 'motionMap', 'planEffects', 'previewRender', 'inspectTimeline', 'inspectClip', 'diffScene', 'recordFix', 'analyzeMedia', 'detectFacecam', 'inspectReference', 'inspectVideo', 'inspectFrames', 'inspectAssetAnalysis', 'markMusicBeats', 'analyzeMusic', 'addMarker', 'moveMarker', 'removeMarker', 'removeMarkers', 'remember', 'recallMemory', 'forget', 'compareReference', 'getFrames', 'askUser', 'askBrandKit', 'previewBackgrounds', 'measureScreen', 'compareScreen', 'readFrames', 'listenReference', 'trackReference', 'measureFrame', 'matchFont', 'traceShape', 'findIcon', 'saveBlueprint', 'listBlueprints', 'getBlueprint', 'readSkill', 'listBrandKits', 'getBrandKit', 'createBrandKit', 'updateBrandKit', 'listVoices', 'analyzeColor', 'trackPoints', 'getTrack', 'addLayer', 'approveClip', 'unapproveClip', 'getSound', 'checkSound', 'readBrief', 'updateBrief']);

/** The timeline windows a scene build covers. A film's beats are cuts of one continuous animation, so it is one window. */
/** A getSound or checkSound result as the agent reads it: lists short enough to scan, one line per second of levels. */
function soundReport(result: SoundResult, check: boolean) {
  const s = (time: number) => `${Math.round(time * 1000) / 1000}s`, onsets = result.onsets.slice(0, 80), words = result.words.slice(0, 200);
  const levels = Array.from({ length: Math.ceil(result.levels.length / 10) }, (_, second) => `${Math.round((result.start + second) * 10) / 10}s: ${result.levels.slice(second * 10, second * 10 + 10).join(' ')} (peak ${Math.max(...result.peaks.slice(second * 10, second * 10 + 10))})`);
  const report = {
    range: `${result.start}-${result.end}s`,
    loudness: `${result.loudness.integrated ?? 'silent'} LUFS integrated, peak ${result.loudness.peak} dBFS`,
    sounds: result.events.map(event => `${event.name} (${event.kind}, clip ${event.clipId}) ${s(event.start)}-${s(event.end)} gain ${event.gain}`),
    onsets: onsets.map(onset => `${s(onset.time)} ${onset.level} dB ${onset.sources.join(' + ') || 'unknown'}`), ...(result.onsets.length > onsets.length ? { moreOnsets: result.onsets.length - onsets.length } : {}),
    levels: { note: 'Momentary loudness in LUFS each 0.1 s, then the loudest sample peak in dBFS that second.', seconds: levels },
    ...(result.silences.length ? { silences: result.silences.map(item => `${s(item.start)}-${s(item.end)}`) } : {}),
    ...(words.length ? { words: words.map(word => `${word.text} ${s(word.start)}-${s(word.end)}`).join(', '), ...(result.words.length > words.length ? { moreWords: result.words.length - words.length } : {}) } : {}),
  };
  if (!check || !result.check) return report;
  const flags = result.check.flags.slice(0, 40);
  return { ...report,
    visualHits: result.check.visualHits.map(hit => `${s(hit.time)} ${Math.round(hit.size * 100)}%`).join(', '),
    soundEffectOnsets: result.check.effectOnsets.map(onset => `${s(onset.time)} ${onset.name}`).join(', '),
    flags: flags.map(flag => ({ at: `${flag.start}-${flag.end}s`, kind: flag.kind, reason: flag.reason })), ...(result.check.flags.length > flags.length ? { moreFlags: result.check.flags.length - flags.length } : {}),
    next: result.check.flags.length ? 'Fix the flagged moments (move each sound effect onto its visual hit, remove extra ones, add missing ones, keep them off spoken words, lower what clips), then run checkSound on that range again. A flag you keep on purpose needs a reason you can name.' : 'Every sound effect lands on its picture change in this range.' };
}

function sceneRanges(name: string, input: Record<string, unknown>) {
  const span = (value: unknown) => { const item = value as { start?: unknown; duration?: unknown; builtThrough?: unknown }; const duration = name === 'addFilm' && typeof item?.builtThrough === 'number' ? item.builtThrough : item?.duration; return typeof item?.start === 'number' && typeof duration === 'number' ? [{ start: item.start, end: item.start + duration }] : []; };
  return name === 'addScenes' && Array.isArray(input.scenes) ? input.scenes.flatMap(span) : span(input);
}
const readLists = (checks: NonNullable<ReturnType<ReadCoverage['sceneCheck']>>[]) => Object.fromEntries((['unreadMoments', 'unseenMoments', 'splitMoments'] as const).map(key => [key, [...new Set(checks.flatMap(check => check[key] ?? []))]]).filter(([, list]) => list.length));

export function createEditorToolkit(ctx: ActionCtx, options: EditorToolkitOptions) {
  const { run, project, assets, recovering, abortSignal } = options;
  const laneCtx=ctx;
  const receipts = new ToolSaveReceipts(run,options.segment);
  ctx = receipts.context(ctx);
  let selectedClipIds = options.selectedClipIds;
  let lane:LaneId=options.lane??'edit';
  const taskId=options.taskId;
  let laneChosen=true;
  const capabilities = new Set(options.capabilities ?? []);
  // previewBackgrounds' candidate documents, for askUser options in the same turn.
  // A model may call previewBackgrounds and askUser in one step; askUser waits for the preview in flight.
  let backgroundPreviews: { label: string; html: string }[] = [];
  let backgroundPreviewRun: Promise<unknown> | undefined;
  const loadCapability = async (name: string) => {
    if (!capabilityExists(name, isMcpRun(run.runId))) throw new Error(`Unknown capability "${name}". Search with discoverCapabilities first.`);
    if (taskId) await laneCtx.runMutation(internal.lanes.loadCapability, { ...taskScope, name });
    capabilities.add(name);
    return capabilitySummary(name, isMcpRun(run.runId));
  };
  let finishRequired=options.finishRequired??true;
  let requiredPersisted=finishRequired;
  const noteToolIntent=(name:string)=>{if(name==='finish'||EDITOR_TOOL_DEFINITIONS[name as keyof typeof EDITOR_TOOL_DEFINITIONS]?.effect==='timeline')finishRequired=true;};
  let timelineId=boundRunTab(run.runId)??project.activeTimelineId??project.timelineTabs?.[0]?.id??'main';
  const timelineIdForLane=()=>timelineId;
  let finishResult:FinishResult|undefined;
  const taskScope={ownerId:run.ownerId,projectId:run.projectId,taskId:taskId??run.runId};
  const ensureBaseline=async()=>{
    if(!taskId)return;
    const task=await laneCtx.runQuery(internal.lanes.task,taskScope) as LaneTask|null;
    if(!task?.baselines.some(item=>item.timelineId===timelineId))await laneCtx.runMutation(internal.lanes.baseline,{...taskScope,baseline:await laneBaseline(timelineId,editSession.timeline,summarizeTimeline(editSession.timeline,assets).gaps)});
  };

  // What this turn has read of a reference, so scenes built over unread moments say so (lib/ai/read-coverage.ts).
  const coverage = new ReadCoverage();
  const sourceFrameRates=new Map<string,number>();
  // The lane's recipe decides every check below. The level only steps up to `final` from the request, never by tool.
  const checkLevel: CheckLevel = options.checkLevel ?? 'standard';
  const recipe = () => laneChecks(lane, checkLevel);
  const tracksChanges = () => tracksChangedFrames(recipe());
  const fastReview = new FastFrameReview(options.pendingFastFrames);
  const readTool = async (name: ReadToolName, input: object) => {
    const result = await runRead(ctx, run.ownerId, run.projectId, name, input, abortSignal, isReferenceAsset((input as { assetId?: string }).assetId));
    if ('status' in result) {
      const timelineId = boundRunTab(run.runId);
      return { ...result, nextAction: { ...result.nextAction, arguments: { ...result.nextAction.arguments, ...(timelineId ? { timelineId } : {}) } }, images: [] };
    }
    let acrossCuts: string[] = [];
    if (name === 'readFrames') {
      const args = input as { assetId: string; start: number; end: number; fps?: number; count?: number; crop?: object; momentsOnly?: boolean };
      if(result.fps)sourceFrameRates.set(args.assetId,result.fps);
      const shots = readReference(assets.find(asset => asset._id === args.assetId)?.analysis?.reference)?.shots ?? [];
      coverage.noteCuts(args.assetId, shots.slice(1).map(shot => shot.start));
      // A map has no frames to look at; a crop or a sheet of one or two frames is a full-size look at its frames.
      const shown = args.momentsOnly ? [] : result.frames.map(frame => frame.time);
      const first = shown[0] ?? args.start, last = shown[shown.length - 1] ?? first;
      coverage.noteRead(args.assetId, { start: first, end: last }, args.momentsOnly ? 0 : args.fps ?? Math.max(0, shown.length - 1) / Math.max(.001, last - first), result.moments ?? [], args.crop || shown.length <= CLOSE_UP_FRAMES ? shown : []);
      acrossCuts = coverage.acrossCuts(args.assetId, result.moments ?? []).map(moment => `${moment.start}-${moment.end}s`);
      const asset = assets.find(asset => asset._id === args.assetId), timelineId = motionTimelineId();
      if ((LANES[lane].referenceMotion === 'required' || isReferenceAsset(args.assetId)) && asset?.kind === 'video' && result.moments?.length && !asset.motionReferenceTimelines?.includes(timelineId)) {
        await ctx.runMutation(internal.referenceMotion.noteReference, { ownerId: run.ownerId, projectId: run.projectId, assetId: asset._id, timelineId });
        asset.motionReferenceTimelines = [...asset.motionReferenceTimelines ?? [], timelineId];
      }
    }
    const summary = readSummary(name, result);
    // A change that runs across a hard cut is one continuous move (a morph, an element carried over the cut): never split it between scenes.
    if (acrossCuts.length) Object.assign(summary, { momentsAcrossCuts: acrossCuts, note: `${summary.note} Moments ${acrossCuts.join(', ')} run across a detected cut: they are one continuous change, so keep each inside one scene or build it as a transition clip; never cut scenes at that shot boundary.` });
    return { ...summary, images: result.image ? [{ label: name === 'trackReference' ? 'Tracked frames, box drawn' : name === 'traceShape' ? 'Crop beside its trace' : name === 'matchFont' ? 'Crop above each font candidate' : 'Frame sheet', data: result.image, mimeType: 'image/jpeg' }] : [] };
  };
  let inspected = false;
  const clippingRun={...run,runId:options.taskId??run.runId};
  const clippingUnavailableReason=async()=>{const state=await ctx.runQuery(internal.clipping.completionState,clippingRun);return 'geminiUnavailableReason' in state?state.geminiUnavailableReason:undefined;};
  let clippingActive=false;
  let clippingTimelineId=boundRunTab(run.runId)??project.activeTimelineId??project.timelineTabs?.[0]?.id??'main';
  type ClipQa='framing'|'decode-health'|'loudness';
  // Final clip checks require QA receipts on every accepted tab: selecting the QA makes finishClipping and finish ask for checkClip.
  // clipping.selectChecks clears every receipt whenever the selection changes, so the selection only grows and always covers every tab;
  // a narrower timelineIds scope from checkClip is not applied at this level.
  const selectClipQa=async(requested:readonly ClipQa[]=[])=>{
    const required=recipe().clipQa??[];
    if(!required.length)return;
    const current=await laneCtx.runQuery(internal.lanes.clipQa,{ownerId:run.ownerId,projectId:run.projectId,runId:clippingRun.runId});
    if(!current)return;
    const checks=[...new Set([...current.checks as ClipQa[],...required,...requested])].sort();
    if(current.allTabs&&checks.length===current.checks.length)return;
    await ctx.runMutation(internal.clipping.selectChecks,{...clippingRun,checks});
  };
  let effectPlans:EffectPlan[]=options.initialPlans;
  // Once this environment reports no review service, later reviews answer at once.
  let reviewServiceMissing=false;
  let videoInspectionUnavailable: string | undefined;
  let videoInspectionQueue = Promise.resolve();
  const optionalVideoInspection = <T,>(work: () => Promise<T>) => {
    const unavailable = () => ({ available: false as const, analyzed: false as const, optional: true, code: 'VIDEO_ANALYSIS_UNAVAILABLE', reason: videoInspectionUnavailable!, next: 'Do not retry unavailable video analysis in this run. Spoken moments may use transcript/voice evidence. Stills, audio peaks and scene cuts do not prove visual action: leave those candidates unresolved and report the missing video evidence. Heavy QA and normalization are not automatic. Billing/provider access must be restored before Gemini video inspection can succeed.' });
    // Concurrent candidate windows share the first failure instead of each
    // uploading another video to an unavailable provider.
    const result = videoInspectionQueue.then(async () => {
      videoInspectionUnavailable ??= await ctx.runQuery(internal.assistant.videoUnavailable, run) ?? (await clippingUnavailableReason()) ?? undefined;
      if (videoInspectionUnavailable) return unavailable();
      try { return await work(); }
      catch (error) {
        if (!(error instanceof AnalysisStepError) || abortSignal.aborted) throw error;
        videoInspectionUnavailable = error.message;
        await ctx.runMutation(internal.assistant.recordVideoUnavailable, { ...run, reason: error.message });
        return unavailable();
      }
    });
    videoInspectionQueue = result.then(() => {}, () => {});
    return result;
  };
  const reviewUnavailableResult={reviewed:false,reviewUnavailable:true,note:'Visual review is not available in this environment. Say the result was not visually checked; do not retry.'};
  const sceneCheckNote='Scenes are checked by their code, never planned or reviewed as effects. Walk through the scene\'s key times in its code instead.';
  const visualEvidence=new Map<string,EffectEvidence>();
  const zoomTargets=new Map<string,ZoomTargetEvidence>();
  const planBindings=new Map<string,string>();
  let editingStarted: Promise<null> | undefined;
  const beginEditing = () => editingStarted ??= ctx.runMutation(internal.assistant.beginEditing, run);
  // Which tools each saved edit came from, for the revision history: those running now, or for a staged
  // replacement published at the end, every tool that staged part of it.
  const runningTools = new Map<string, number>(), stagedTools = new Set<string>();
  const editingTools = (publication?: boolean) => {
    const names = publication ? [...stagedTools] : [...runningTools.keys()];
    if (publication) stagedTools.clear();
    return names.length ? { tool: names.join(', ').slice(0, 120) } : {};
  };
  const editSession = new EditSession(project.timeline ?? { clips: [], fps: 60, aspectRatio: project.aspectRatio }, project.revision ?? 0, {
    apply: (timeline, expectedRevision,publication) => receipts.commit(() => ctx.runMutation(internal.assistant.apply, { ...run, timeline, expectedRevision,...(publication?{stagedPublication:true}:{}),...(publication&&options.publication?{publication:options.publication}:{}), ...editingTools(publication) })),
    validate: (timeline, expectedRevision) => ctx.runMutation(internal.assistant.previewDraft, { ...run, timeline, expectedRevision }),
    refresh: async () => { return await ctx.runQuery(internal.assistant.getRunTimeline,run); },
    beforeChange: beginEditing,
  }, abortSignal);
  if(options.draft){const before=editSession.timeline;editSession.restoreDraft(options.draft);receipts.restoredDraft();if(tracksChanges())fastReview.changed(before,options.draft);}
  const motionTimelineId = timelineIdForLane;
  const referenceMotionEnabled = () => !!LANES[lane].referenceMotion;
  const recreationRender = () => referenceMotionEnabled() && (LANES[lane].referenceMotion === 'required' || editSession.timeline.clips.some(clip => clip.scene?.film?.referenceAssetId));
  const referenceAssetId = () => {
    if (!referenceMotionEnabled()) return undefined;
    const references = [...new Set(editSession.timeline.clips.flatMap(clip => clip.scene?.film?.referenceAssetId ? [clip.scene.film.referenceAssetId] : []))];
    const targets = referenceMotionTargets(editSession.timeline, assets, motionTimelineId(), LANES[lane].referenceMotion === 'required');
    const candidate = references.length === 1 ? references[0] : references.length ? undefined : LANES[lane].referenceMotion === 'required' ? (targets.length === 1 ? targets[0].assetId : undefined) ?? coverage.referenceAssetId() : undefined;
    return assets.find(asset => asset._id === candidate)?.kind === 'video' ? candidate : undefined;
  };
  const motionState = (assetId: string) => ctx.runQuery(internal.referenceMotion.state, { ownerId: run.ownerId, projectId: run.projectId, assetId: assetId as Id<'assets'>, timelineId: motionTimelineId() });
  const isReferenceAsset = (assetId?: string) => referenceMotionEnabled() && !!assetId && (referenceAssetId() === assetId || editSession.timeline.clips.some(clip => clip.scene?.film?.referenceAssetId === assetId));
  const motionStatus = async (): Promise<{ motionCheck?: string; motionOff?: (MotionOff & { assetId: string })[]; closeOut?: string }> => {
    if (!referenceMotionEnabled()) return {};
    const targets = referenceMotionTargets(editSession.timeline, assets, motionTimelineId(), LANES[lane].referenceMotion === 'required');
    const references = [...new Set(targets.map(target => target.assetId))];
    const candidate = referenceAssetId();
    if (!references.length && candidate) references.push(candidate);
    if (!references.length) return {};
    const timelineKey = await motionTimelineKey(editSession.timeline), reports: string[] = [], exceptions: (MotionOff & { assetId: string })[] = [];
    for (const assetId of references) {
      const state = await motionState(assetId);
      const ranges = targets.filter(target => target.assetId === assetId);
      reports.push(...ranges.map(range => motionReport({ ...range, revision: editSession.revision, timelineKey, checks: state.checks, off: state.off })));
      exceptions.push(...state.off.map(item => ({ assetId, ...item })));
    }
    return { motionCheck: reports.join('\n'), ...(exceptions.length ? { motionOff: exceptions, closeOut: 'Include every motionOff time and reason in the final close-out. OFF never means matched.' } : {}) };
  };
  const motionGate = async (assetId: string, start: number, end: number) => {
    if (!referenceMotionEnabled()) return undefined;
    const state = await motionState(assetId), duration = assets.find(asset => asset._id === assetId)?.duration ?? end;
    const missing = missingMotionWindow(start, Math.min(end, duration), [...state.windows, ...state.off]);
    if (!missing) return undefined;
    // The smallest measurable call is .3 s; pad a short tail so the offered call can really clear it.
    const window = { start: Math.max(0, Math.min(missing.start, missing.end - .3)), end: missing.end };
    const next = { projectId: run.projectId, assetId, ...window };
    const offAction = { tool: 'motionMap', arguments: { ...next, off: { time: missing.start, reason: duration < .3 ? "The reference is shorter than motionMap's 0.3 s measurement minimum." : 'Describe the measurement limitation at this time (12–500 characters).' } } };
    return { ...await motionStatus(), success: false, saved: false, refused: 'motion_reads', error: `Run motionMap on the reference ${motionRange(window)} before building this section.`, nextAction: duration < .3 ? offAction : { tool: 'motionMap', arguments: next }, offAction, note: 'If motionMap cannot measure this window, or after 2 failed tries, call offAction with the actual time and reason. OFF clears coverage but never means matched.' };
  };
  // Approved work (lib/editor/approvals.ts) is refused unless the call passes overrideApproved with the user's reason.
  // The override covers the calls running under it; what it let through is reported back on that call.
  const approvalOverride = { active: 0, reason: '', overridden: [] as ApprovalViolation[] };
  const checkpoint = async (edit: (timeline: Timeline) => Timeline) => {
    const result = await editSession.checkpoint(timeline => { if (recovering && !inspected) throw new Error('Inspect the current timeline before continuing the saved edit.');
    const next = edit(timeline), collision = newLayerOverlaps(timeline, next)[0];
    // Refuse before the draft changes; the server repeats this check on every assistant write.
    if (collision) throw new TimelineGestureRejection(`Clips ${collision[0].id} and ${collision[1].id} would overlap on the same layer. Move one to another time or layer first.`, 'overlap');
    const touched = approvalViolations(timeline, next);
    if (touched.length && !approvalOverride.active) throw new TimelineGestureRejection(approvalRefusal(touched), 'approved');
    approvalOverride.overridden.push(...touched);
    return next; });
    receipts.checkpoint(result);
    return result;
  };
  // Blueprint checks run on the media worker; wait for one like getFrames waits for frames.
  const blueprintCheck = async (checkId: Id<'blueprintChecks'>) => {
    const deadline = Date.now() + MCP_WORKER_WAIT_MS;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) throw new Error('Stopped.');
      const state = await ctx.runQuery(internal.blueprints.checkState, { ownerId: run.ownerId, checkId });
      if (state.status === 'failed') throw new Error(state.error ?? 'The blueprint check failed.');
      if (state.status === 'completed') return state as { result: Doc<'blueprintChecks'>['result'] & {} };
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('The blueprint check took too long. Try again.');
  };
  // A scene snapshots each blueprint's code when it mounts it, like its brand; editScene refreshes them.
  const sceneBlueprints = async (kitId: string | undefined, names: string[]) => {
    if (!kitId) throw new Error('Mounting blueprints needs the brand kit they belong to (brandKitId).');
    return Promise.all([...new Set(names)].map(async name => { const found = await ctx.runQuery(internal.blueprints.getForTools, { ownerId: run.ownerId, kitId, name }); return { name: found.name, code: found.code }; }));
  };
  const markerCheckpoint = async (edit: (timeline: Timeline) => Timeline) => {
    const result = await checkpoint(edit);
    return { ...result, removed: result.removedMarkerIds.length };
  };
  const sceneMediaInput = z.array(z.object({ name: z.string().regex(/^[a-zA-Z][\w-]{0,30}$/).describe('How the scene code reads it: media.<name>.'), assetId: z.string().describe('An image or video in this project, from getProject media.') })).describe('Project images and short videos the scene shows (screenshots, screen recordings, logos, photos). The scene receives them as media.<name> URLs for <img src>, <video src> or CSS backgrounds.');
  const sceneBlueprintInput = z.array(z.string().trim().min(1).max(60)).max(SCENE_BLUEPRINT_LIMIT).describe('Blueprint names from the brand kit (listBlueprints) to mount with blueprint(name, container); needs brandKitId.');
  const scopeItem = z.union([z.string().trim().min(1).max(120), z.object({ start: z.number().min(0), end: z.number().positive() }).strict()]);
  const scopeInput = z.union([scopeItem, z.array(scopeItem).min(1).max(8)]).describe("The part of the film the user asked to change: a section marker label or id (inspectTimeline markers), or a {start, end} range in film seconds (a section() call's start to start + duration); a list for several. Inferred for code changes isolated to one section; required for shared-code changes on a film with more than one section. Every section outside it is locked for this call: if the change reaches code a locked section uses or shared code outside the section() calls, those sections are rendered before and after and the change is refused if they would look different.");
  const codeLinesInput = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().describe('Inclusive absolute line numbers in the current scene, starting at 1, from inspectClip.');
  const codeSectionInput = z.string().trim().min(1).describe('Section marker label or id from inspectTimeline or a scoped inspectClip. Selects its section() calls and the top-level declarations they use, including shared helpers.');
  const sceneEditsInput = z.array(z.object({
    find: z.string().min(1).optional().describe('Current code from inspectClip, without line-number prefixes. Line indentation differences are tolerated when the match is unique.'),
    lines: codeLinesInput.optional(),
    all: z.boolean().optional().describe('Replace every matching snippet; only valid with find.'),
    insert: z.enum(['before', 'after']).optional().describe('Keep the snippet or lines and insert replace before or after them.'),
    replace: z.string().describe('Replacement code, or empty to delete. Required even for insertions.'),
  }).strict().superRefine((edit, context) => {
    if ((edit.find === undefined) === (edit.lines === undefined)) context.addIssue({ code: 'custom', path: ['find'], message: 'Give exactly one of find or lines.' });
    if (edit.lines !== undefined && edit.all !== undefined) context.addIssue({ code: 'custom', path: ['all'], message: 'all is only valid for find edits.' });
  }).transform((edit): SceneEdit | SceneLineEdit => edit.lines !== undefined ? { lines: edit.lines, replace: edit.replace, ...(edit.insert ? { insert: edit.insert } : {}) } : { find: edit.find!, replace: edit.replace, ...(edit.all !== undefined ? { all: edit.all } : {}), ...(edit.insert ? { insert: edit.insert } : {}) })).min(1).max(30).superRefine((edits, context) => {
    for (const [index, edit] of edits.entries()) if (('lines' in edit) !== ('lines' in edits[0])) context.addIssue({ code: 'custom', path: [index, 'lines'], message: 'Use either line edits or find edits throughout a call.' });
  });
  type SceneInput = { id?: string; title: string; code: string; start: number; duration: number; track?: number; brand?: NonNullable<Clip['scene']>['brand']; media?: { name: string; assetId: string }[]; blueprints?: { name: string; code: string }[] };
  // A new scene clip on a free layer.
  const placeScene = (t: Timeline, { id = crypto.randomUUID(), title, code, brand, media, blueprints, ...timing }: SceneInput) => {
    return placeOnFreeLayer(t, { id, kind: 'scene', sourceStart: 0, ...timing, scene: { title, code, ...(brand ? { brand } : {}), ...(media?.length ? { media } : {}), ...(blueprints?.length ? { blueprints } : {}) } });
  };
  const sceneMedia = (items: { name: string; assetId: string }[]) => {
    if (new Set(items.map(item => item.name)).size !== items.length) throw new Error('Give each scene image a different name.');
    for (const item of items) { const asset = assets.find(entry => entry._id === item.assetId); if (!asset || (asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'model')) throw new Error(`${item.assetId} is not an image, video or model in this project. Upload screenshots or recordings first (uploadMedia), then use their assetId.`); if (asset.kind === 'video' && (asset.duration ?? 0) > 120) throw new Error('Scene videos can be up to 2 minutes; trim the recording or use it as a video clip instead.'); }
    return items;
  };
  const find = (timeline: Timeline, id: string) => { const clip = timeline.clips.find(c => c.id === id); if (!clip) throw new Error("Clip not found"); return clip; };
  const approvedNote = (timeline: Timeline) => { const approved = approvedWork(timeline); return approved.length ? { approved, approvedRule: APPROVED_RULE } : {}; };
  const textColor = z.string().regex(/^(#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|transparent)$/i);
  const appearanceColor=z.string().regex(/^#[\da-f]{6}$/i);
  const textStyleInput=z.object({strokeWidth:z.number().min(TEXT_APPEARANCE_LIMITS.strokeWidth[0]).max(TEXT_APPEARANCE_LIMITS.strokeWidth[1]).optional(),strokeColor:appearanceColor.optional(),shadowBlur:z.number().min(TEXT_APPEARANCE_LIMITS.shadowBlur[0]).max(TEXT_APPEARANCE_LIMITS.shadowBlur[1]).optional(),shadowX:z.number().min(TEXT_APPEARANCE_LIMITS.shadowX[0]).max(TEXT_APPEARANCE_LIMITS.shadowX[1]).optional(),shadowY:z.number().min(TEXT_APPEARANCE_LIMITS.shadowY[0]).max(TEXT_APPEARANCE_LIMITS.shadowY[1]).optional(),shadowColor:appearanceColor.optional(),glowBlur:z.number().min(TEXT_APPEARANCE_LIMITS.glowBlur[0]).max(TEXT_APPEARANCE_LIMITS.glowBlur[1]).optional(),glowColor:appearanceColor.optional(),fontWeight:z.number().int().min(TEXT_TYPOGRAPHY_LIMITS.fontWeight[0]).max(TEXT_TYPOGRAPHY_LIMITS.fontWeight[1]).optional(),italic:z.boolean().optional(),letterSpacing:z.number().min(TEXT_TYPOGRAPHY_LIMITS.letterSpacing[0]).max(TEXT_TYPOGRAPHY_LIMITS.letterSpacing[1]).optional(),lineHeight:z.number().min(TEXT_TYPOGRAPHY_LIMITS.lineHeight[0]).max(TEXT_TYPOGRAPHY_LIMITS.lineHeight[1]).optional(),textAlign:z.enum(['left','center','right']).optional(),paddingX:z.number().min(0).max(200).optional(),paddingY:z.number().min(0).max(200).optional(),borderRadius:z.number().min(0).max(200).optional()});
  const fontFamily=z.enum(TEXT_FONTS.map(font=>font.id));
  const clipIdsInput=z.array(z.string().min(1).max(100)).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,{message:'Choose unique clip IDs.'});
  // A named easing, or a cubic-bézier [x1,y1,x2,y2] (y may overshoot for anticipation/bounce).
  const motionEasingInput=z.union([z.enum(MOTION_EASINGS),z.tuple([z.number().min(0).max(1),z.number().min(-1).max(2),z.number().min(0).max(1),z.number().min(-1).max(2)])]);
  const objectMotionInput=z.object({clipId:z.string().min(1),replaceMotion:z.boolean().optional(),keyframes:z.array(z.object({time:z.number().min(0),x:z.number().min(-1).max(1),y:z.number().min(-1).max(1),scale:z.number().min(.1).max(5),rotation:z.number().min(-360).max(360),opacity:z.number().min(0).max(1),brightness:z.number().min(0).max(4),easing:motionEasingInput.optional()}).strict()).max(120)}).strict();
  const pulseInputs={
    flash:z.object({strength:z.number().min(0).max(1).optional(),attack:z.number().min(.01).max(.99).optional(),release:z.number().min(.01).max(.99).optional()}).strict().optional(),
    shake:z.object({strength:z.number().min(0).max(1).optional(),speed:z.number().min(.25).max(4).optional(),direction:z.enum(['both','horizontal','vertical']).optional()}).strict().optional(),
    punch:z.object({amount:z.number().min(PUNCH_LIMITS.amount[0]).max(PUNCH_LIMITS.amount[1]).optional(),speed:z.number().min(PUNCH_LIMITS.speed[0]).max(PUNCH_LIMITS.speed[1]).optional(),centerX:z.number().min(0).max(1).optional(),centerY:z.number().min(0).max(1).optional(),attack:z.number().min(PUNCH_LIMITS.attack[0]).max(PUNCH_LIMITS.attack[1]).optional(),release:z.number().min(PUNCH_LIMITS.release[0]).max(PUNCH_LIMITS.release[1]).optional()}).strict().optional(),
  };
  const zoomInput=z.object({direction:z.enum(['in','out']).optional(),amount:z.number().min(ZOOM_LIMITS.amount[0]).max(ZOOM_LIMITS.amount[1]).optional(),speed:z.number().min(ZOOM_LIMITS.speed[0]).max(ZOOM_LIMITS.speed[1]).optional(),centerX:z.number().min(0).max(1).optional(),centerY:z.number().min(0).max(1).optional()});
  const solidColorInput=z.object({color:z.string().regex(/^#[\da-f]{6}$/i).optional(),width:z.number().min(SOLID_COLOR_LIMITS.width[0]).max(SOLID_COLOR_LIMITS.width[1]).optional(),height:z.number().min(SOLID_COLOR_LIMITS.height[0]).max(SOLID_COLOR_LIMITS.height[1]).optional(),x:z.number().min(0).max(1).optional(),y:z.number().min(0).max(1).optional(),opacity:z.number().min(0).max(1).optional()});
  const textInput = z.object({ text: z.string().min(1).max(2000), track: z.number().int().min(1).max(24).optional(), start: z.number().min(0), duration: z.number().positive(), fontSize: z.number().min(8).max(300).optional(),fontFamily:fontFamily.optional(), color: textColor.optional(), background: textColor.optional(), blendMode: z.enum(BLEND_MODES).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), animation: z.enum(["none", "fade", "rise"]).optional(),textStyle:textStyleInput.optional() });
  const withAnalysis = async <T,>(assetId: string, mode: "highlights" | "transcribe" | "shots" | "beats" | "track" | "video" | "frames" | "reference" | "facecam" | "speakers", read: (request: Doc<"analysisRequests">) => Promise<T>, inspection?: { highlightSkipGemini?:string; highlightSourceType?:z.infer<typeof sourceType>; videoRequest?: VideoInspectionInput; frameRequest?: FrameInspectionInput; speakerRequest?:{start:number;end:number} }) => {
    // Healthy worker heartbeats extend the durable request, but must not extend
    // an MCP call past its transport budget while it holds the edit lock.
    const waitDeadline = isMcpRun(run.runId) ? Date.now() + MCP_WORKER_WAIT_MS : Infinity;
    const requestId = await retryAbortedTransaction(() => ctx.runMutation(internal.assistant.requestAnalysis, { ...run, assetId, mode, ...inspection }), abortSignal);
    try {
      while (true) {
        abortSignal.throwIfAborted();
        const request = await ctx.runQuery(internal.assistant.analysisRequest, { ...run, requestId });
        if (request.status === "failed") throw new AnalysisStepError(request.error ?? "Media analysis could not complete");
        if (request.status === "completed") return await read(request);
        if (Math.min(request.expiresAt, waitDeadline) <= Date.now()) throw new AnalysisStepError("Media analysis is taking longer than this edit request allows. Its background job will save results; try the edit again once processing finishes.");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally { await ctx.runMutation(internal.assistant.clearAnalysis, { ...run, requestId }); }
  };
  const loadAsset=async(assetId:string)=>{const asset=materializeTranscript(await ctx.runQuery(internal.assistant.getRunAsset,{...run,assetId}));const index=assets.findIndex(item=>item._id===asset._id);if(index<0)throw new Error('Choose media from this project');assets[index]=asset;return asset;};
  const savedCheckpoint=async(assetId:string,edit:(timeline:Timeline)=>Timeline)=>{await loadAsset(assetId);return checkpoint(edit);};
  // Processed copies (freeze stills, smooth slow motion, upscales) come from the media worker.
  type DeriveInput={clipId:string;assetId:string;op:'freeze'|'slowmo'|'upscale'|'stats'|'parallax'|'pixelTrack';selection?:Pick<PixelTrackRequest, 'time' | 'seed' | 'segmenter'>;tracking?:PixelTrackRequest;start:number;end:number;backgroundPrompt?:string;time?:number;times?:number[];factor?:number;target?:number;fps?:number;placeLater:boolean};
  // SAM 3.1 (Meta) serves MCP clients only; derivations/cutouts set it from this run id server-side.
  const mcpSurface=isMcpRun(run.runId);
  const derive=(input:DeriveInput)=>ctx.runMutation(internal.derivations.startFromRun,{...run,...input});
  const adoptAsset=async(assetId:string)=>{const asset=materializeTranscript(await ctx.runQuery(internal.assistant.getRunAsset,{...run,assetId}));const index=assets.findIndex(item=>item._id===asset._id);if(index<0)assets.push(asset);else assets[index]=asset;return asset;};
  // Color measured on the worker from a clip's source frames at timeline moments (default: three across the clip).
  const measureClip=async(clip:Timeline['clips'][number],times?:number[]):Promise<ColorStats[]>=>{
    if((clip.kind!=='video'&&clip.kind!=='image')||!clip.assetId)throw new Error('Measure color on a video or image clip.');
    const end=clip.start+clip.duration-1/editSession.timeline.fps,moments=(times?.length?times:[.15,.5,.85].map(fraction=>clip.start+clip.duration*fraction)).map(time=>Math.min(end,Math.max(clip.start,time)));
    const sourceTimes=clip.kind==='image'?[0]:moments.map(time=>sourceTimeAt(clip,time));
    const started=await derive({clipId:clip.id,assetId:clip.assetId,op:'stats',start:sourceTimes[0],end:sourceTimes[sourceTimes.length-1],times:sourceTimes,placeLater:false});
    const deadline=Date.now()+90_000;
    while(true){
      abortSignal.throwIfAborted();
      const row=await ctx.runQuery(internal.derivations.runStatus,{...run,derivationId:started.derivationId});
      if(row.status==='failed')throw new AnalysisStepError(row.error??'Color measurement failed.');
      if(row.status==='completed'&&row.stats)return row.stats as ColorStats[];
      if(Date.now()>deadline)throw new AnalysisStepError('Color measurement is taking too long. Try again in a minute.');
      await new Promise(resolve=>setTimeout(resolve,700));
    }
  };
  /** Build a Genesis function on the timeline from a ready layer, and record where it placed the layer for finish checks. */
  const applyGenesis = async (layerId: string, clipId: string | undefined, fn: string, build: (timeline: Timeline, layer: Awaited<ReturnType<typeof readyLayer>>, stack: { clipIds: string[]; subjectClipIds: string[] }) => Applied) => {
    const layer = await readyLayer(layerId);
    const stack = await ctx.runQuery(internal.genesis.stackForRun, { ...run, timelineId: timelineIdForLane(), baseClipId: clipId ?? layer.clipId });
    let applied: Applied | undefined;
    const saved = await checkpoint(t => { applied = build(t, layer, stack); return applied.timeline; });
    const placed = applied!;
    await ctx.runMutation(internal.genesis.recordApplication, { ...run, layerId: layer.layerId, application: { timelineId: timelineIdForLane(), function: fn, baseClipId: placed.baseClipId, clipIds: placed.clipIds, subjectClipIds: placed.subjectClipIds } });
    const span = find(placed.timeline, placed.baseClipId), mid = Math.round((span.start + span.duration / 2) * 100) / 100;
    return { ...saved, layerId: layer.layerId, footageClipId: placed.baseClipId, clipIds: placed.clipIds, subjectClipIds: placed.subjectClipIds, next: `getFrames at ${mid}s (and where the subject moves fastest), then finish.` };
  };
  const readyLayer = (layerId: string) => ctx.runQuery(internal.genesis.readyForRun, { ...run, layerId });
  /** Genesis jobs read a footage clip's source range (on its own clock) and change only its media when applied. */
  const genesisFootage = async (clipId: string) => { await editSession.wait(); const clip = find(editSession.timeline, clipId); if (clip.kind !== 'video' || !clip.assetId) throw new Error('Choose a video footage clip.'); return clip; };
  const startGenesisJob = (kind: 'depth' | 'relight' | 'effect', clip: Clip, params: unknown, layerIds: string[], depthId?: string) => {
    const a = clip.sourceStart, b = sourceEndOf(clip);
    return ctx.runMutation(internal.genesisJobs.startFromRun, { ...run, kind, clipId: clip.id, assetId: clip.assetId!, start: Math.min(a, b), end: Math.max(a, b), params, layerIds, ...(depthId ? { depthId } : {}) });
  };
  const pollJob = (status: string) => status === 'ready' ? undefined : 'Poll getJob with this jobId every 15-30 seconds until ready.';
  const pixelSeedInput = z.union([trackSeed, z.object({ kind: z.literal('object'), noun: z.string().trim().min(1).max(120) }).strict(), z.object({ kind: z.literal('target'), targetId: z.string().min(1) }).strict()]);
  const resolveSubjectSeed = (seed:z.infer<typeof pixelSeedInput>,assetId:string|undefined,time:number):PixelTrackRequest['seed'] => {
    if(seed.kind!=='target')return seed;
    const target=zoomTargets.get(seed.targetId);
    if(!target||target.assetId!==assetId||Math.abs(target.time-time)>1/(target.sourceFps??30)+1e-6||target.confidence==='low')throw new Error('Use a confident inspectFrames target on this source at the seed time.');
    return {kind:'box',box:target.box};
  };
  const trackInput = z.object({ footageClipId: z.string().min(1), time: z.number().nonnegative(), seed: pixelSeedInput, start: z.number().nonnegative().optional(), end: z.number().positive().optional() }).strict();
  const readPixelTrack = async (trackId: string, footage: Clip): Promise<PixelTrackReference> => {
    const row = await ctx.runQuery(internal.derivations.runStatus, { ...run, derivationId: trackId });
    if (row.sourceAssetId !== footage.assetId) throw new Error('This track belongs to different source footage.');
    if (row.status === 'failed') throw new Error(row.error ?? 'Pixel tracking failed.');
    return ctx.runQuery(internal.pixelTracks.referenceForRun, { ...run, trackId });
  };
  const measurePixelTrack = async (input: z.infer<typeof trackInput>) => {
    await editSession.wait();
    const footage = find(editSession.timeline, input.footageClipId);
    if (footage.kind !== 'video' || !footage.assetId) throw new Error('Choose an uploaded video clip.');
    const asset = await loadAsset(footage.assetId), start = input.start ?? footage.start, end = input.end ?? footage.start + footage.duration;
    if (start < footage.start || end > footage.start + footage.duration + 1e-6 || input.time < start || input.time >= end) throw new Error('Seed time and tracking window must be inside the footage clip, in timeline seconds.');
    let time = sourceTimeAt(footage, input.time);
    let seed: PixelTrackRequest['seed'];
    if (input.seed.kind === 'target') {
      const target = zoomTargets.get(input.seed.targetId);
      if (!target || target.assetId !== asset._id || Math.abs(target.time - time) > 1 / (target.sourceFps ?? 30) + 1e-6 || target.confidence === 'low') throw new Error('Use a confident inspectFrames target on this source at the seed time.');
      seed = { kind: 'box', box: target.box }; time = target.time;
    } else seed = input.seed;
    const tracking = pixelTrackRequest.parse({ start: sourceTimeAt(footage, start), end: sourceTimeAt(footage, end), time, seed });
    const started = await derive({ clipId: footage.id, assetId: asset._id, op: 'pixelTrack', tracking, start: tracking.start, end: tracking.end, placeLater: false });
    return ctx.runQuery(internal.pixelTracks.referenceForRun, { ...run, trackId: started.derivationId });
  };
  const curveInput=z.array(z.tuple([z.number().min(0).max(1),z.number().min(0).max(1)])).min(2).max(16);
  const awaitDerivation=async(derivationId:Id<'derivations'>,limitMs:number)=>{
    const deadline=Date.now()+limitMs;
    while(true){
      abortSignal.throwIfAborted();
      const row=await ctx.runQuery(internal.derivations.runStatus,{...run,derivationId});
      if(row.status==='failed')throw new AnalysisStepError(row.error??'Media processing failed.');
      if(row.status==='completed'&&row.outputAssetId)return adoptAsset(row.outputAssetId);
      if(Date.now()>deadline)throw new AnalysisStepError('Media processing is taking longer than this edit allows. Try again in a minute.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  };
  // A media task links to one analysis request. Parallel tool calls for the
  // same source and mode share one request: a second request would relink the
  // task and leave the first waiting until it timed out.
  const sharedAnalyses = new Map<string, ReturnType<typeof analyzeOnce>>();
  const speakerWindows = new Map<string, SpeakerAnalysis>();
  const transcriptRefreshFailures = new Map<string, string>();
  const understandingUnavailable = (assetId: string) => ({ assetId, mode: 'understand', analyzed: false, optional: true, understandingNote: OPTIONAL_UNDERSTANDING_NOTE });
  const analyze = async (assetId: string, mode: "transcribe" | "shots" | "beats" | "track" | "reference" | "facecam" | "speakers", requireAudioActivity = false, speakerRequest?:{start:number;end:number}) => {
    const key = `${assetId}:${mode}:${JSON.stringify(speakerRequest?{start:Math.round(speakerRequest.start*1000)/1000,end:Math.round(speakerRequest.end*1000)/1000}:null)}`;
    const remembered=mode==='speakers'?speakerWindows.get(key):undefined;
    if(remembered){const asset=await loadAsset(assetId);return {...asset,analysis:{...asset.analysis,speakers:remembered}};}
    const shared = sharedAnalyses.get(key);
    if (shared) {
      const asset = await shared;
      // The shared call may not have needed boundary audio; measure it afterwards.
      return requireAudioActivity && asset.analysis?.audioActivity?.version !== AUDIO_ACTIVITY_VERSION ? analyzeOnce(assetId, mode, true) : asset;
    }
    const pending = analyzeOnce(assetId, mode, requireAudioActivity, false, speakerRequest).then(asset=>{if(mode==='speakers'&&asset.analysis?.speakers)speakerWindows.set(key,asset.analysis.speakers);return asset;}).finally(() => sharedAnalyses.delete(key));
    sharedAnalyses.set(key, pending);
    return pending;
  };
  const analyzeOnce = async (assetId: string, mode: "transcribe" | "shots" | "beats" | "track" | "reference" | "facecam" | "speakers", requireAudioActivity = false, remeasure = false,speakerRequest?:{start:number;end:number}) => {
    if(!remeasure&&(mode==='facecam'||mode==='speakers')){const saved=await loadAsset(assetId),cached=saved.analysis?.speakers;if(mode==='facecam'?!!saved.analysis?.facecam:cached?.version===SPEAKER_ANALYSIS_VERSION&&cached.start<=(speakerRequest?.start??0)&&cached.end>=(speakerRequest?.end??saved.duration??0))return saved;}
    if (!remeasure && mode === 'shots') { const saved = await loadAsset(assetId); if (saved.analysis?.shots) return saved; }
    if (!remeasure && (mode === 'transcribe' || mode === 'reference')) {
      const saved = await loadAsset(assetId);
      if (mode === 'reference' ? readReference(saved.analysis?.reference)?.moments : currentTranscript(saved.analysis?.transcript) && (!requireAudioActivity || saved.analysis?.audioActivity?.version === AUDIO_ACTIVITY_VERSION)) return saved;
    }
    const request = () => withAnalysis(assetId, mode, async request => {
      let next=materializeTranscript(await ctx.runQuery(internal.assistant.getRunAsset,{...run,assetId}));
      if(mode==='speakers'&&request.speakerInspection)next={...next,analysis:{...next.analysis,speakers:request.speakerInspection}};
      if (!next?.analysis) throw new Error("Media analysis completed without saved results");
      if (mode === 'beats' && next.analysis.beats?.engine !== BEAT_ANALYSIS_ENGINE) throw new Error("Dedicated beat tracking did not return a current beat map. Analyze this audio source again.");
      const index = assets.findIndex(asset => asset._id === next._id); assets[index] = next;
      return next;
    },speakerRequest?{speakerRequest}:undefined);
    let next = await request();
    // An already running pre-upgrade task may finish with transcript only.
    // One local backfill upgrades that evidence without repeating transcription.
    if (requireAudioActivity && next.analysis?.transcript && next.analysis.audioActivity?.version !== AUDIO_ACTIVITY_VERSION) next = await request();
    if (requireAudioActivity && (!next.analysis?.transcript || next.analysis.audioActivity?.version !== AUDIO_ACTIVITY_VERSION)) throw new AnalysisStepError('Audio boundary measurement is unavailable. No unverified speech trims were applied.');
    return next;
  };
  // Speech cuts share one path: the source's cleanup map removes pauses, breaths and fillers between
  // words, and every kept piece snaps to its words' measured sound to the millisecond.
  const speechEvidence = async (clipId: string) => {
    await editSession.wait();
    const clip = find(editSession.timeline, clipId);
    if (clip.kind !== 'video' && clip.kind !== 'audio') throw new Error('Choose a video or audio clip with speech.');
    // Upload preparation stores speech evidence on the video source.
    const pair = clip.kind === 'audio' && clip.linkedClipId ? editSession.timeline.clips.find(member => member.id === clip.linkedClipId && member.linkedClipId === clip.id && member.kind === 'video') : undefined;
    const assetId = pair?.assetId ?? clip.assetId;
    if (!assetId) throw new Error('Choose uploaded speech media.');
    let evidence = await analyze(assetId, 'transcribe', true);
    // A source transcribed before cleanup maps existed is measured once more.
    if (!currentSpeechCleanup(evidence.analysis?.speechCleanup)) evidence = await analyzeOnce(assetId, 'transcribe', true, true).catch(() => evidence);
    const cleanup = currentSpeechCleanup(evidence.analysis?.speechCleanup) && evidence.analysis?.transcript ? evidence.analysis.speechCleanup : undefined;
    const offset = clip.assetId === evidence._id ? 0 : pair ? pair.sourceStart - clip.sourceStart : undefined;
    if (offset === undefined) throw new Error('The speech evidence no longer matches this linked source.');
    return { clip, evidence, cleanup, offset, sourceEnd: clip.sourceStart + clip.duration * playbackRateOf(clip) };
  };
  const applySpeechCut = async (clipId: string, speech: Awaited<ReturnType<typeof speechEvidence>>, chosenRanges: { start: number; end: number }[], kinds: Set<string>, minConfidence: number, preview = false) => {
    const { clip, evidence, offset, sourceEnd } = speech, cleanup = speech.cleanup!;
    const chosen = chosenRanges.map(range => ({ start: Math.max(clip.sourceStart, range.start), end: Math.min(sourceEnd, range.end) })).filter(range => range.end > range.start);
    if (!chosen.length) throw new Error('None of the ranges is inside this clip’s retained source.');
    const inside = (cut: { start: number; end: number }) => chosen.some(range => cut.end > range.start && cut.start < range.end);
    // Cuts in this clip's source time, only where the kept ranges are.
    const cuts: CleanupCut[] = cleanup.cuts.filter(cut => kinds.has(cut.kind) && cut.confidence >= minConfidence).map(cut => ({ ...cut, start: cut.start - offset, end: cut.end - offset })).filter(inside);
    const transcript = evidence.analysis!.transcript!, activity = evidence.analysis!.audioActivity;
    const ranges = chosen.flatMap(range => keptRanges(range.start, range.end, cuts)).map(range => {
      const source = { start: range.start + offset, end: range.end + offset };
      const measured = cleanup.edges?.length === transcript.words.length * 2 ? snapToSpeech(source, transcript.words, cleanup.edges) : activity ? refineAudioRangeEdges(source, transcript, activity) : source;
      return { start: Math.max(range.start, measured.start - offset), end: Math.min(range.end, measured.end - offset) };
    }).filter(range => (range.end - range.start) / playbackRateOf(clip) >= 1 / editSession.timeline.fps);
    const chosenLength = chosen.reduce((total, range) => total + range.end - range.start, 0), keptLength = ranges.reduce((total, range) => total + range.end - range.start, 0);
    const count = (kind: string) => cuts.filter(cut => cut.kind === kind).length;
    // What the user is told: the edit removed these, on top of the ranges that were chosen.
    const speechCleanup = { pauses: count('pause'), breaths: count('breath'), fillers: count('filler'), retakes: count('restart'), removedSeconds: Math.round(Math.max(0, chosenLength - keptLength) * 100) / 100, keptPieces: ranges.length, edges: 'measured word sound, millisecond-exact' };
    if (preview) return { preview: true, speechCleanup, cuts: cuts.slice(0, 200).map(cut => ({ kind: cut.kind, start: cut.start, end: cut.end, confidence: cut.confidence, detail: cut.detail })), keptRanges: ranges };
    if (!ranges.length) throw new Error('Cleanup would remove everything chosen; raise minConfidence or limit kinds.');
    if (ranges.length > 100) throw new Error(`Cleanup would split this clip into ${ranges.length} pieces; clean a shorter clip, raise minConfidence or limit kinds.`);
    let retainedRanges: RetainedRangeSummary[] = [];
    // Speech edges are measured to the millisecond; rounding them to frames would add back up to 33 ms of air per edge.
    const result = await checkpoint(t => { const retained = retainSourceRanges(t, clipId, ranges, undefined, true); retainedRanges = retained.ranges; return retained.timeline; });
    return { ...result, speechCleanup, retainedRanges };
  };
  const transformFields={units:z.enum(VISUAL_INPUT_UNITS).optional(),x:z.number().optional(),y:z.number().optional(),scale:z.number().min(VISUAL_TRANSFORM_LIMITS.scale[0]).max(VISUAL_TRANSFORM_LIMITS.scale[1]).optional(),rotation:z.number().min(-360).max(360).optional(),opacity:z.number().min(0).max(1).optional()};
  // Library and generated sound effects share one A layer above dialogue and music when it is free.
  const isEffectSound = (clip: Timeline['clips'][number]) => clip.kind === 'audio' && assets.some(item => item._id === clip.assetId && (isStockAudioKey(item.r2Key) || item.soundRecipe !== undefined));
  const placeEffectSound = async (assetId: string, duration: number, at: number, gain: number) => {
    let id: string = crypto.randomUUID(), overlapping: { clipId: string; role: string }[] = [];
    const result = await checkpoint(t => {
      const frame = 1 / t.fps, start = Math.round(at * t.fps) / t.fps, audio = t.clips.filter(clip => clip.kind === 'audio');
      const placed = recovering ? t.clips.find(clip => clip.assetId === assetId && Math.abs(clip.start - start) < frame) : undefined;
      if (placed) { id = placed.id; return t; }
      const effects = audio.filter(isEffectSound).map(trackOf), others = audio.filter(clip => !isEffectSound(clip)).map(trackOf);
      const track = Math.min(maxTrackCount('audio'), effects.length ? Math.min(...effects) : Math.max(0, ...others) + 1);
      overlapping = audio.filter(clip => !isEffectSound(clip) && (clip.volume ?? 1) > 0 && clip.start < start + duration && start < clip.start + clip.duration).map(clip => ({ clipId: clip.id, role: audioSettings(clip).role }));
      return patchClip(addMediaClip(t, { _id: assetId, kind: 'audio', duration }, id, start, track), id, { volume: gain });
    });
    return { ...result, clipId: id, gain, overlapsAudio: overlapping };
  };
  // Generate with ElevenLabs, upload to the project's R2 media like an upload, and register an ordinary audio asset holding its request.
  const reserveAudio = async () => { abortSignal.throwIfAborted(); await ctx.runMutation(internal.assistant.reserveAudioRequest, run); abortSignal.throwIfAborted(); };
  const createGeneratedSound = async (request: SoundEffectRequest, name?: string) => {
    const { samples, rate } = await generateSoundEffect(request, abortSignal, reserveAudio), key = newProjectMediaKey(run.ownerId, run.projectId);
    const size = await putMediaObject(key, encodeWav(samples, rate), 'audio/wav');
    try {
      const asset = await ctx.runMutation(internal.assistant.saveGeneratedSound, { ...run, r2Key: key, fileName: `${(name ?? 'Generated sound').replace(/[\\/:*?"<>|]/g, '')}.wav`, size, duration: samples[0].length / rate, waveform: soundWaveform(samples, rate), recipe: JSON.stringify(request) });
      assets.push(asset);
      return asset;
    } catch (error) { await storageControl({ action: 'delete', key }).catch(() => {}); throw error; }
  };
  // Choice-card previews (voice samples, rendered stills) live in the project's R2 media without becoming assets; the card reads them through a signed URL.
  const publishPreview = async (bytes: Uint8Array<ArrayBuffer>, contentType: string) => {
    const key = newProjectMediaKey(run.ownerId, run.projectId, 'preview-');
    await putMediaObject(key, bytes, contentType);
    return (await mediaUrl(ctx, { r2Key: key }))!;
  };
  // Render frames of the saved (or this turn's staged) timeline as base64 JPEGs, as export draws them.
  const renderFrames = async (times: number[], revision?: number, targetTimelineId?:string, resolution?:720|1080) => {
    await editSession.wait();
    const timelineId = targetTimelineId??boundRunTab(run.runId);
    const snapshotId = await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged && revision === undefined && (!targetTimelineId||targetTimelineId===timelineIdForLane()) ? { runId: run.runId } : {}), ...(timelineId ? { timelineId } : {}), times, ...(resolution?{resolution}:{}), ...(revision !== undefined ? { revision } : {}) });
    const deadline = Date.now() + 280_000;
    let started = false;
    while (Date.now() < deadline) {
      if (abortSignal.aborted) { await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); throw new Error('Stopped.'); }
      const state = await ctx.runMutation(internal.mcp.takeFrames, { ownerId: run.ownerId, snapshotId });
      if (state.started) started = true;
      if (state.status === 'failed') { await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); throw new Error(`Frames could not be rendered: ${state.error ?? 'unknown error'}`); }
      if (state.status === 'completed') { await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); return { revision: state.revision as number, ...(state.atRevision !== undefined ? { atRevision: state.atRevision as number } : {}), resolution:resolution??720, frames: (await snapshotFrames(state)).map(frame => ({ ...frame })) }; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    await ctx.runMutation(internal.mcp.discardFrames, { snapshotId });
    // Say which wait it was: frames that never started were queued behind other renders, not too many.
    throw new Error(started ? 'Frames took too long to render. Try fewer times.' : 'These frames never started rendering: the media worker stayed busy with other renders. Try again shortly; the number of times was not the problem.');
  };
  // The visual guard: the working timeline and a proposed change, rendered at the same times on the media worker.
  const guardRender = async (baseline: Timeline, candidate: Timeline, times: number[]) => {
    const snapshotId = await ctx.runMutation(internal.mcp.requestGuard, { ...run, baseline, candidate, times });
    try {
      // MCP transport expires before the in-app guard budget. Refuse before any save.
      const deadline = Date.now() + (isMcpRun(run.runId) ? MCP_WORKER_WAIT_MS : 420_000);
      while (Date.now() < deadline) {
        if (abortSignal.aborted) throw new Error('Stopped.');
        const state = await ctx.runMutation(internal.mcp.takeFrames, { ownerId: run.ownerId, snapshotId });
        if (state.status === 'failed') throw new Error(`Nothing was changed: the visual guard could not render (${state.error ?? 'unknown error'}). Try again.`);
        if (state.status === 'completed') return state as { differences: number[]; frames: { time: number; image: string }[] };
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error('Nothing was changed: the visual guard took too long to render. Try again shortly.');
    } finally { await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); }
  };
  /**
   * A change to a film with several sections is scoped to what the user asked about; every other section is locked
   * for the call. When the change reaches locked code (a locked section, or shared code outside the section() calls),
   * the locked sections are rendered before and after, and any visible difference refuses the change with the images.
   */
  const scopedChange = async (clipId: string, scope: ScopeInput | ScopeInput[] | undefined, edit: (timeline: Timeline) => Timeline, what: string) => {
    await editSession.wait();
    const before = editSession.timeline, clip = before.clips.find(item => item.id === clipId);
    if (clip?.kind !== 'scene' || !clip.scene) return {};
    const count = sectionCount(clip.scene), after = edit(before), next = after.clips.find(item => item.id === clipId)?.scene;
    if (!next) return {};
    // Renaming a clip cannot change its picture or another section.
    if (equalTimelineValue({ ...clip.scene, title: '' }, { ...next, title: '' })) return {};
    let inferred = false;
    if (scope === undefined) {
      if (count < 2) return {};
      const candidates = sectionRanges(clip.scene).filter(range => !guardedSections(clip.scene!, next, [range]).length);
      if (candidates.length === 1) { scope = candidates[0]; inferred = true; }
      else if (clip.scene.code === next.code && equalTimelineValue(clip.scene.blueprints, next.blueprints)) {
        // A binding refresh may add unused media. Check every section rather than forcing a scope for invisible changes.
        scope = []; inferred = true;
      } else throw new Error(`Nothing was changed. This edit cannot be isolated to one of the film's ${count} sections. Pass scope for the sections the user asked to change: ${sectionMarkersIn(before, clip).map(marker => `"${marker.label ?? marker.id}"`).join(', ') || sectionRanges(clip.scene).map(range => JSON.stringify(range)).join(', ')}. Shared-code edits need scope covering the affected sections; all other sections stay locked.`);
    }
    const ranges = resolveScope(before, clip, scope);
    const named = ranges.map(range => `${range.label ? `"${range.label}" ` : ''}film ${range.start}-${range.end}s`).join(', ') || 'binding refresh; every existing section locked';
    const scopeResult = { scope: named, ...(inferred ? { scopeInferred: true } : {}) };
    const locked = guardedSections(clip.scene, next, ranges), film = before.clips.filter(item => item.kind === 'scene' && item.scene?.code === clip.scene!.code);
    const times = guardTimes(film, locked, before.fps).map(item => ({ ...item, time: Math.round(item.time * 1000) / 1000 }));
    if (!times.length) return scopeResult;
    if (!recipe().fullTools) return { refusal: { success: false, saved: false, error: 'This patch touches shared code outside the requested section. Keep the change in that section so this lane can check only the changed spot.' } };
    const { differences, frames } = await guardRender(before, after, times.map(item => item.time));
    const changed = times.map((item, index) => ({ ...item, difference: differences[index] ?? 0 })).filter(item => item.difference > GUARD_LIMIT);
    if (!changed.length) return { ...scopeResult, guard: { passed: true, checked: times.map(item => item.time), note: `Code outside the scope changed; the ${locked.length} locked section(s) it reaches render the same, so it was saved.` } };
    const sections = [...new Map(changed.map(item => [item.range.start, item.range])).values()];
    return { refusal: { success: false, saved: false, applied: false, refused: 'scope', scope: named, changedSections: sections, changedFrames: changed.map(item => ({ time: item.time, film: item.range, changedShare: item.difference })),
      error: `Nothing was changed. This ${what} would change how sections outside the scope (${named}) look: ${sections.map(range => `film ${range.start}-${range.end}s`).join(', ')} (${changed.map(item => `timeline ${item.time}s: ${Math.round(item.difference * 1000) / 10}% of the frame differs`).join('; ')}). They are locked because the user did not ask to change them. Keep the change inside the scope: put new styles, helpers or camera moves in the scoped section() call or in new top-level declarations only it uses, instead of editing code other sections share. If the user did ask for those sections too, add them to scope.`,
      images: frames.map(frame => ({ label: `Before (left) and after (right) at timeline ${Math.round(frame.time * 1000) / 1000}s`, data: frame.image, mimeType: 'image/jpeg' })) } };
  };
  // motionMap: how a reference or the timeline moves, read on the media worker as camera keyframes, transitions, element
  // tweens and content changes; with both, where the timeline moves differently from the reference.
  const timelineMotion = async (start: number, end: number, crop?: ComparisonCrop, aspectRatio?: number): Promise<{ map: MotionMap; revision: number }> => {
    await editSession.wait();
    const timelineId = boundRunTab(run.runId);
    const snapshotId = await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged ? { runId: run.runId } : {}), ...(timelineId ? { timelineId } : {}), times: [], motion: { start, end }, ...(crop || aspectRatio ? { comparison: { ...(crop ? { crop } : {}), ...(aspectRatio ? { aspectRatio } : {}) } } : {}) });
    try {
      const deadline = Date.now() + 540_000;
      for (let state = await ctx.runMutation(internal.mcp.takeFrames, { ownerId: run.ownerId, snapshotId }); ; state = await ctx.runMutation(internal.mcp.takeFrames, { ownerId: run.ownerId, snapshotId })) {
        if (abortSignal.aborted) throw new Error('Stopped.');
        if (state.status === 'failed') throw new Error(`The motion map could not render the range: ${state.error ?? 'unknown error'}`);
        if (state.status === 'completed') return { map: state.motion as MotionMap, revision: state.revision };
        if (Date.now() > deadline) throw new Error(state.started ? 'The motion map took too long. Map a shorter range.' : 'The motion map never started: the media worker stayed busy with other renders. Try again shortly.');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } finally { await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); }
  };
  const motionMap = async (input: { assetId?: string; start: number; end: number; timelineStart?: number; off?: { time: number; reason: string } } & ComparisonCrops) => {
    const { off, ...measurement } = input;
    // Before a film is bound, an explicit motionMap source selects the reference among other inspected footage.
    if (LANES[lane].referenceMotion === 'required' && input.assetId && !editSession.timeline.clips.some(clip => clip.scene?.film?.referenceAssetId)) {
      const asset = assets.find(asset => asset._id === input.assetId && asset.kind === 'video');
      const mapped = assets.filter(asset => asset.motionReferenceTimelines?.includes(motionTimelineId()));
      if (asset && (mapped.length !== 1 || mapped[0]._id !== asset._id)) {
        await ctx.runMutation(internal.referenceMotion.noteReference, { ownerId: run.ownerId, projectId: run.projectId, assetId: asset._id, timelineId: motionTimelineId(), select: true });
        for (const source of assets) source.motionReferenceTimelines = source._id === asset._id ? [...source.motionReferenceTimelines ?? [], motionTimelineId()] : source.motionReferenceTimelines?.filter(id => id !== motionTimelineId());
      }
    }
    const assetId = input.assetId, actualReference = referenceAssetId();
    if (off) {
      if (!isReferenceAsset(assetId) || !assetId) throw new Error(`Mark off a window on the actual recreation reference (${actualReference ?? 'read the reference with readFrames first'}).`);
      await ctx.runMutation(internal.referenceMotion.markOff, { ownerId: run.ownerId, projectId: run.projectId, assetId: assetId as Id<'assets'>, timelineId: motionTimelineId(), start: input.start, end: input.end, ...off });
      return { off: true, matched: false, ...await motionStatus() };
    }
    const duration = assets.find(asset => asset._id === assetId)?.duration ?? Math.max(input.end, input.start + .3);
    const retryStart = Math.min(input.start, Math.max(0, duration - .3)), retryEnd = Math.min(duration, retryStart + 12, Math.max(input.end, retryStart + .3));
    const nextAction = { tool: 'motionMap', arguments: { projectId: run.projectId, ...measurement, start: retryStart, end: retryEnd } };
    const offAction = isReferenceAsset(assetId) ? { tool: 'motionMap', arguments: { ...nextAction.arguments, off: { time: retryStart, reason: duration < .3 ? "The reference is shorter than motionMap's 0.3 s measurement minimum." : 'Describe what motionMap cannot measure at this time (12–500 characters).' } } } : undefined;
    let snapshotId: Id<'frameSnapshots'> | undefined;
    try {
      if (input.end - input.start < .3 || input.end - input.start > 12) throw new Error('Choose a motion window of 0.3 to 12 seconds.');
      const length = input.end - input.start, referenceCrop = input.referenceCrop ?? input.crop, timelineCrop = input.timelineCrop ?? input.crop;
      const shown = (map: MotionMap) => { const { track: _track, ...rest } = map; return { ...rest, elements: rest.elements.slice(0, 20), changes: rest.changes.filter(change => change.area >= 1).slice(0, 20) }; };
      if (!assetId) { const { map, revision } = await timelineMotion(input.start, input.end, timelineCrop); return { revision, timeline: shown(map) }; }
      if (input.timelineStart !== undefined) {
        const asset = assets.find(asset => asset._id === assetId), region = referenceCropAt(input.start, referenceCrop, input.referenceCropKeyframes);
        if (!asset?.width || !asset.height) throw new Error('The reference needs readable video dimensions. Retry after its import finishes, or mark this window off.');
        const bounds = region ? cropBounds(region, asset.width, asset.height) : { width: asset.width, height: asset.height };
        await editSession.wait();
        snapshotId = await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged ? { runId: run.runId } : {}), timelineId: motionTimelineId(), times: [], motion: { start: input.timelineStart, end: input.timelineStart + length }, comparison: { ...(timelineCrop ? { crop: timelineCrop } : {}), aspectRatio: bounds.width / bounds.height } });
      }
      const result = await ctx.runAction(internal.referenceMotion.measure, { ownerId: run.ownerId, projectId: run.projectId, assetId: assetId as Id<'assets'>, start: input.start, end: input.end, recreation: isReferenceAsset(assetId), ...(snapshotId ? { snapshotId } : {}), ...(referenceCrop ? { referenceCrop } : {}), ...(input.referenceCropKeyframes ? { referenceCropKeyframes: input.referenceCropKeyframes } : {}) });
      return { ...measurement, ...(result.revision !== undefined ? { revision: result.revision } : {}), reference: shown(result.reference), ...(result.timeline ? { timeline: shown(result.timeline), differences: result.differences } : {}), ...await motionStatus(), next: result.differences?.length ? 'Fix every difference with patchScene and recheck, or mark the affected window OFF with its time and reason. OFF never means matched.' : 'Verify the inventory in rendered pixels, including each layer, overshoot and settle; still frames alone never certify motion.' };
    } catch (error) {
      const data = error && typeof error === 'object' && 'data' in error ? error.data as { status?: string; message?: string } : undefined;
      const errorMessage = data?.message ?? (error instanceof Error ? error.message : String(error));
      return { success: false, checkPassed: false, status: data?.status === 'still_queued' || errorMessage.includes('Still queued after') ? 'still_queued' : 'not_checked', error: errorMessage, retryAfterSeconds: 30, nextAction: duration < .3 && offAction ? offAction : nextAction, ...(offAction ? { offAction } : {}), note: 'Wait about 30 s and retry nextAction. If this cannot be measured, or after 2 failed tries, call offAction with a concrete timed reason. A refused check is not a pass.', ...await motionStatus() };
    } finally { if (snapshotId) await ctx.runMutation(internal.mcp.discardFrames, { snapshotId }); }
  };
  // Pacing renders the whole range on the media worker and returns measurements only, so it may take minutes.
  const checkPacing = async (input: { start?: number; end?: number; fps?: number; checkId?:string; sourceCheckId?:string; revision?:number }) => {
    await editSession.wait();
    const duration = timelineDuration(editSession.timeline), start = input.start ?? 0, end = input.end ?? duration, timelineId = boundRunTab(run.runId);
    const sourceSnapshotId = input.sourceCheckId ? await ctx.runQuery(internal.mcp.normalizeSnapshotId,{snapshotId:input.sourceCheckId,ownerId:run.ownerId,projectId:run.projectId,kind:'pacing',...(timelineId?{timelineId}:{})}) : undefined;
    const snapshotId = input.checkId ? await ctx.runQuery(internal.mcp.normalizeSnapshotId,{snapshotId:input.checkId,ownerId:run.ownerId,projectId:run.projectId,kind:'pacing',...(timelineId?{timelineId}:{})}) : await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged ? { runId: run.runId } : {}), ...(timelineId ? { timelineId } : {}), ...(input.revision!==undefined?{revision:input.revision}:{}), ...(sourceSnapshotId ? { sourceSnapshotId } : {}), times: [], pacing: { start, end:end-start<=9?end:start+8, fps: input.fps ?? 10 } });
    const deadline = Date.now() + 45_000;
    for (let state = await ctx.runQuery(internal.mcp.frames, { ownerId: run.ownerId, snapshotId }); ; state = await ctx.runQuery(internal.mcp.frames, { ownerId: run.ownerId, snapshotId })) {
      const checkedRevision = (state.atRevision ?? state.revision) as number, checkedTimelineId = state.timelineId ?? timelineId;
      const requestedEnd = input.end ?? (input.checkId ? state.requestedRange?.end ?? end : end);
      if (abortSignal.aborted) throw new Error('Stopped.');
      if (state.status === 'failed') throw new Error(`Saved pacing check ${snapshotId} at revision ${checkedRevision} could not render the range: ${state.error ?? 'unknown error'}`);
      if (state.status === 'completed') {
        const result = state.pacing as PacingResult, shown = result.flags.slice(0, 30);
        const next=result.end+1/(input.fps??10);
        return { checkId:snapshotId, ...(checkedTimelineId?{timelineId:checkedTimelineId}:{}), completed:next>=requestedEnd-1/(input.fps??10),...(next<requestedEnd-1/(input.fps??10)?{nextAction:{tool:'checkPacing',arguments:{projectId:run.projectId,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),sourceCheckId:snapshotId,start:result.end,end:requestedEnd,revision:checkedRevision,...(input.fps?{fps:input.fps}:{})}},note:'This chunk is complete. Follow nextAction until completed is true to check the whole requested range.'}:{}), revision: checkedRevision, range: `${result.start}-${result.end}s`, samples: `${result.samples} at ${result.fps} fps`, changePerSecond: result.changePerSecond.map((value, second) => `${Math.round(result.start) + second}s ${value}%`).join(', '), cuts: result.cuts, cameraMoves: result.moves, flags: shown.map(flag => ({ at: `${flag.start}-${flag.end}s`, kind: flag.kind, reason: flag.reason })), ...(result.flags.length > shown.length ? { moreFlags: result.flags.length - shown.length } : {}),
          next: result.flags.length ? 'Fix the flagged moments in the scene code (longer holds, eased moves, fewer changes per second), then run checkPacing on that range again. A flag you keep on purpose (a deliberate snap or flash) needs a reason you can name.' : 'No pacing problems found in this range.' };
      }
      if (Date.now() > deadline) return {status:'pending',checkId:snapshotId,revision:checkedRevision,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),nextAction:{tool:'checkPacing',arguments:{projectId:run.projectId,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),checkId:snapshotId,end:requestedEnd,revision:checkedRevision,...(input.fps?{fps:input.fps}:{})}},note:'The saved chunk keeps running. Follow nextAction to retrieve it; no new job is started.'};
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };
  // Listening decodes the range's mix on the media worker (and for a check also samples its picture), so it may take minutes.
  const listen = async (input: { start?: number; end?: number; fps?: number; checkId?:string; sourceCheckId?:string; revision?:number }, check: boolean) => {
    await editSession.wait();
    const duration = timelineDuration(editSession.timeline), start = input.start ?? 0, end = input.end ?? duration, timelineId = boundRunTab(run.runId), name = check ? 'checkSound' : 'getSound';
    const sourceSnapshotId = input.sourceCheckId ? await ctx.runQuery(internal.mcp.normalizeSnapshotId,{snapshotId:input.sourceCheckId,ownerId:run.ownerId,projectId:run.projectId,kind:'sound',...(timelineId?{timelineId}:{}),check}) : undefined;
    const snapshotId = input.checkId ? await ctx.runQuery(internal.mcp.normalizeSnapshotId,{snapshotId:input.checkId,ownerId:run.ownerId,projectId:run.projectId,kind:'sound',...(timelineId?{timelineId}:{}),check}) : await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged ? { runId: run.runId } : {}), ...(timelineId ? { timelineId } : {}), ...(input.revision!==undefined?{revision:input.revision}:{}), ...(sourceSnapshotId ? { sourceSnapshotId } : {}), times: [], sound: { start, end:end-start<=9?end:start+8, check, ...(input.fps ? { fps: input.fps } : {}) } });
    const deadline = Date.now() + 45_000;
    for (let state = await ctx.runQuery(internal.mcp.frames, { ownerId: run.ownerId, snapshotId }); ; state = await ctx.runQuery(internal.mcp.frames, { ownerId: run.ownerId, snapshotId })) {
      const checkedRevision = (state.atRevision ?? state.revision) as number, checkedTimelineId = state.timelineId ?? timelineId;
      const requestedEnd = input.end ?? (input.checkId ? state.requestedRange?.end ?? end : end);
      if (abortSignal.aborted) throw new Error('Stopped.');
      if (state.status === 'failed') throw new Error(`Saved ${name} check ${snapshotId} at revision ${checkedRevision} could not decode the range: ${state.error ?? 'unknown error'}`);
      if (state.status === 'completed') {
        const result=state.sound as SoundResult;
        return {checkId:snapshotId,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),completed:result.end>=requestedEnd-1e-6,...(result.end<requestedEnd-1e-6?{nextAction:{tool:name,arguments:{projectId:run.projectId,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),sourceCheckId:snapshotId,start:Math.max(start,Math.min(result.end,requestedEnd-.3-1e-6)),end:requestedEnd,revision:checkedRevision,...(input.fps?{fps:input.fps}:{})}},note:'This chunk is complete. Follow nextAction until completed is true to check the whole requested range.'}:{}),revision:checkedRevision,...soundReport(result,check)};
      }
      if (Date.now() > deadline) return {status:'pending',checkId:snapshotId,revision:checkedRevision,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),nextAction:{tool:name,arguments:{projectId:run.projectId,...(checkedTimelineId?{timelineId:checkedTimelineId}:{}),checkId:snapshotId,end:requestedEnd,revision:checkedRevision,...(input.fps?{fps:input.fps}:{})}},note:'The saved chunk keeps running. Follow nextAction to retrieve it; no new job is started.'};
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };
  const trimChangeInput=z.object({clipId:z.string().min(1),duration:z.number().positive(),sourceStart:z.number().min(0).optional()});
  const verifyCurrentTimeline = async () => {
    await editSession.wait();
    const missingFrames = !clippingActive && tracksChanges() ? fastReview.feedback() : undefined;
    if (missingFrames) throw new Error(missingFrames);
    // Effect plans gate only lanes that run full checks; a lane switch mid-task cannot strand them behind refused review tools.
    if (effectPlans.length && recipe().fullTools) {
      const state = await ctx.runQuery(internal.compositionReview.completionState, { ...run, timeline: editSession.timeline, expectedRevision: editSession.revision });
      const feedback = completionRepairFeedback([], 'stop', { ...state, revision: editSession.revision });
      if (feedback) throw new Error(feedback);
    }
  };
  const switchTimeline = async (open: (revision: number) => Promise<{ timeline: Timeline; revision: number; timelineId: string }>) => {
    await verifyCurrentTimeline();
    const result = await editSession.switchTimeline(open);
    timelineId=result.timelineId;
    finishResult=undefined;
    if(taskId)await laneCtx.runMutation(internal.lanes.switchLane,{...taskScope,timelineId,lane,reason:'Continuing this task in another timeline'});
    await ensureBaseline();
    if (result.timelineChanged) {
      selectedClipIds = [];
      effectPlans = [];
      stagedTools.clear();
    }
    inspected = true;clippingTimelineId=result.timelineId;
    return { ...result, note: 'Editing tools now act on this timeline. Inspect it before editing. Publish this tab before opening another. Finish clipping directly after building accepted tabs; scoped heavy QA is optional. Never call tab changes in parallel with edits.' };
  };
  /** A song's measured structure, measuring it first when its beat map or energy is missing. */
  const readSong = async (input: { clipId?: string; assetId?: string; lengths?: number[] }) => {
    await editSession.wait();
    let clip = input.clipId ? find(editSession.timeline, input.clipId) : undefined;
    // A video's sound lives on its linked audio clip.
    if (clip?.kind === 'video' && clip.linkedClipId) clip = find(editSession.timeline, clip.linkedClipId);
    if (clip && (clip.kind !== 'audio' || !clip.assetId)) throw new Error('Choose the song\'s audio clip.');
    let asset = await loadAsset(clip?.assetId ?? input.assetId!);
    if (!clip && asset.kind === 'video' && asset.audioAssetId) asset = await loadAsset(asset.audioAssetId);
    if (asset.kind !== 'audio' && asset.kind !== 'video') throw new Error('Choose a song: an audio file or a video with sound.');
    if (asset.analysis?.beats?.engine !== BEAT_ANALYSIS_ENGINE || !asset.analysis.beats.energy) asset = await analyze(asset._id, 'beats');
    const map = asset.analysis?.beats;
    if (!map?.energy) throw new AnalysisStepError('The media worker returned a beat map without music energy; it may be older than this tool. Try again once the worker has updated.');
    // Sung words come from the song's own transcript, or its video's when the song is a video's sound.
    const linked = clip?.linkedClipId ? editSession.timeline.clips.find(item => item.id === clip!.linkedClipId)?.assetId : undefined;
    const words = asset.analysis?.transcript?.words.length ? asset.analysis.transcript.words : linked ? (await loadAsset(linked)).analysis?.transcript?.words ?? [] : [];
    // Target lengths are timeline seconds; the song's bars are source seconds.
    const rate = clip && !clip.speedRamp?.length ? playbackRateOf(clip) : 1;
    return { clip, asset, map, words, structure: musicStructure({ ...map, energy: map.energy }, asset.duration ?? map.energy.loudness.length * map.energy.step, words, input.lengths?.map(length => length * rate)) };
  };
  const tools = {
    findHighlights:createTool({metadata:EDITOR_TOOL_DEFINITIONS.findHighlights,
      description:'Read saved transcript and lightweight helpers to propose 15-60s candidates without whole-source video judging. For requested dialogue pass speechLed:true; podcast/talk defaults to that. Commentary over gaming/action does not prove visuals irrelevant. Use short explicit inspectVideo windows to establish visual events; silent content uses bounded adaptive video discovery. Register grounded planClips found moments, then accept/drop and build. Preserve original framing/audio. Finish uses inline data checks, without normalization or heavy checkClip unless requested. Returns recommendedCount and a quality bar of 65/100; only candidates at or above the bar qualify.',

      inputSchema:z.object({assetId:z.string(),sourceType:sourceType.optional(),speechLed:z.boolean().optional().describe("True when the requested moments are spoken dialogue, including interview or stream dialogue. Commentary over gaming/action does not make visuals irrelevant."),visualReview:z.boolean().optional().describe('True when this request depends on visual context. Discovery still uses targeted short video windows, never whole-video judging.'),count:z.number().int().min(1).max(10).optional(),delivery:z.enum(['candidates','clips']).default('candidates')}),execute:async(_ctx,input)=>{
        let asset = await loadAsset(input.assetId);
        const transcriptOnly = !input.visualReview && (input.speechLed || input.sourceType === 'podcast' || input.sourceType === 'talk');
        if (transcriptOnly && !asset.analysis?.transcript?.words.length) asset = await analyze(input.assetId, 'transcribe');
        clippingActive = input.delivery === 'clips';
        return ctx.runMutation(internal.clipping.begin, { ...clippingRun, assetId: asset._id, delivery: clippingActive,
          transcriptOnly, ...(input.sourceType ? { sourceType: input.sourceType } : {}), ...(input.count ? { count: input.count } : {}) });
      }}),
    planClips:createTool({metadata:EDITOR_TOOL_DEFINITIONS.planClips,
      description:'For transcript-first discovery or if findHighlights fell back, first register the COMPLETE found:[{title,start,end,kind,hook,payoff,reactionEnd,score,reason}] set after reading the transcript; each successful found call replaces the previous candidate set. On the visual path, spoken moments are grounded by their quotes; action or non-verbal hook/payoff moments need a saved targeted inspectVideo observation, and come back unresolved when Gemini is unavailable or the inspection budget is spent. Quotes must match saved words/times; leave non-verbal quotes empty. It returns current server IDs and suggested clean start/end. Use those ranges by default; changes must stay within 12s of each suggested boundary, retain hook/payoff, and last 15-60s. Then record every reviewed top-10 ID as accepted or dropped with a concrete reason. Accepted candidates each need one unique title, clean SOURCE start/end and their own populated tab (source aspect/framing unless the user requests reframing). Use candidate IDs from findHighlights. Bind timelineId when known; exact unique tab titles also resolve. Revise this plan if a candidate is dropped after building; restore/remove its abandoned tab. No padding. Finish compares the plan to populated tabs and cheap data; only explicitly selected QA needs receipts. shortfallReason is included in finishClipping\'s finalMessage. Updating the plan after dropping a built candidate removes its abandoned tab only when this batch created it and it holds no user-approved work.',
      inputSchema:z.object({shortfallReason:z.string().trim().min(20).max(500).optional().describe('Concrete quality/context/boundary reason fewer clips than the source-length target qualified. Required for a shortfall without explicit dropped-candidate reasons.'),found:z.array(semanticMoment).min(1).max(30).optional(),accepted:z.array(z.object({candidateId:z.string(),name:z.string().trim().min(1).max(60),start:z.number().nonnegative(),end:z.number().positive(),timelineId:z.string().optional(),criticalRegions:z.array(z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().positive().max(1),h:z.number().positive().max(1)})).max(12).optional()})).max(10).optional(),dropped:z.array(z.object({candidateId:z.string(),reason:z.string().min(8).max(500)})).max(80).optional()}),execute:async(_ctx,input)=>{clippingActive=true;return ctx.runMutation(internal.clipping.review,{...clippingRun,...input,editorRunId:run.runId});}}),
    checkClip:createTool({metadata:EDITOR_TOOL_DEFINITIONS.checkClip,
      description:'OPTIONAL scoped QA only when the user requests it. checks selects framing (one sampled rendered sheet), decode-health (retained source diagnostics), or loudness (existing verified measurement). No normalization is implicitly required. Without checks, only cheap saved-data validation runs. Finish does not require this tool. Reuses unchanged passing AND failing results; inspect findings or fix the affected tab, never rerun an unchanged whole batch. acceptedFindings can acknowledge intentional black/freeze after actual review; corruption cannot be waived.',

      inputSchema:z.object({timelineIds:z.array(z.string()).min(1).max(10).optional(),checks:z.array(z.enum(['framing','decode-health','loudness'])).max(3).optional().describe('Only the checks the user explicitly requested. Omit for cheap data validation.'),acceptedFindings:z.array(z.object({kind:z.enum(['freeze','black']),reason:z.string().min(15).max(500)})).max(8).optional()}),execute:async(_ctx,input)=>{
        clippingActive=true;await editSession.wait();
        if (recipe().clipQa) await selectClipQa(input.checks);
        else if (input.checks) await ctx.runMutation(internal.clipping.selectChecks, { ...clippingRun, checks: input.checks, ...(input.timelineIds ? { timelineIds: input.timelineIds } : {}) });
        await editSession.publish();
        const state: { required: boolean; tabs?: { timelineId: string; checked: boolean }[]; reviewMode?: string } = await ctx.runQuery(internal.clipping.completionState,{...clippingRun,timeline:editSession.timeline,timelineId:clippingTimelineId});
        if ('reviewMode' in state && state.reviewMode === 'transcript') await editSession.publish();
        const checkedIds=new Set<string>(state.tabs?state.tabs.filter((tab:{checked:boolean})=>tab.checked).map((tab:{timelineId:string})=>tab.timelineId):[]);
        const requestedIds:string[]=[...new Set<string>(input.timelineIds??(state.tabs?state.tabs.map((tab:{timelineId:string})=>tab.timelineId):[]))];
        const reusedTimelineIds=requestedIds.filter(id=>checkedIds.has(id)),ids=requestedIds.filter(id=>!checkedIds.has(id));
        if(!ids.length){if(state.tabs?.length)return {results:[],images:[],alreadyChecked:true,reusedTimelineIds,next:'Accepted tabs pass the current saved-data checks and any explicitly requested QA. Call finishClipping; repair any accounting errors it reports.'};throw new Error('Build accepted clip tabs before checkClip.');}
        const results:unknown[]=[],images:{label:string;data:string;mimeType:string}[]=[];
        await forEachLimited(ids,2,async(timelineId)=>{
          const prepared=await ctx.runQuery(internal.clipping.prepareCheck,{...clippingRun,timelineId,...(input.acceptedFindings?{acceptedFindings:input.acceptedFindings}:{})});
          if (!prepared.qualityChecks.length) {
            results.push(await ctx.runMutation(internal.clipping.checkTranscript, { ...clippingRun, timelineId }));
            return;
          }
          if (prepared.cachedResult) { results.push({ timelineId, ...prepared.cachedResult, reused: true }); return; }
          const snapshotId=await ctx.runMutation(internal.mcp.requestFrames,{ownerId:run.ownerId,projectId:run.projectId,...(editSession.staged?{runId:run.runId}:{}),timelineId,times:[],clipCheck:prepared.request});
          try {
            while(true){abortSignal.throwIfAborted();const checked=await ctx.runMutation(internal.mcp.takeFrames,{ownerId:run.ownerId,snapshotId});
              if(checked.status==='failed')throw new AnalysisStepError(checked.error??'Clip check failed.');
              if(checked.status==='completed'){if(!checked.clipCheck)throw new Error('Clip check completed without data.');const result=clipCheckResult.parse(JSON.parse(checked.clipCheck));results.push({timelineId,...result});if(checked.frames?.[0])images.push({label:`${timelineId}: sampled framing only`,data:checked.frames[0].image,mimeType:'image/jpeg'});break;}
              await new Promise(resolve=>setTimeout(resolve,1000));
            }
          }finally{await ctx.runMutation(internal.mcp.discardFrames,{snapshotId});}
        });
        results.sort((a,b)=>ids.indexOf((a as {timelineId:string}).timelineId)-ids.indexOf((b as {timelineId:string}).timelineId));
        const failedTimelineIds=results.filter(result=>!(result as {passed:boolean}).passed).map(result=>(result as {timelineId:string}).timelineId);
        return {results,images,reusedTimelineIds,failedTimelineIds,next:failedTimelineIds.length?'Review the actual failed data or optional QA findings. Do not retry unchanged failures or passing tabs. Fix only affected edits or explicitly scope an intentional black/freeze acknowledgement. Never normalize automatically.':'FinishClipping and finish can now validate the saved data. Unrequested heavy checks and normalization are skipped.'};
      },toModelOutput:(ctx,options)=>blueprintImages(ctx,options.output)}),
    finishClipping:createTool({metadata:EDITOR_TOOL_DEFINITIONS.finishClipping,description:'Server-enforced clipping close-out: compare accepted candidates against actual created/changed tabs, populated source footage, names, source ranges, duration and cheap saved-data checks inline. Only explicitly requested scoped QA requires receipts; no compulsory checkClip, normalization or media job. Returns trusted found/accepted/tabs counts, drop reasons and an exact finalMessage to report. Fix every error before saying done.',inputSchema:z.object({}),execute:async()=>{
      await editSession.wait();await selectClipQa();const state=await ctx.runQuery(internal.clipping.completionState,{...clippingRun,timeline:editSession.timeline,timelineId:clippingTimelineId});
      if(!state.passed)throw new Error(`Clipping delivery is incomplete: ${JSON.stringify(state.errors)}`);
      return state;
    }}),
    generateImage: createTool({
      metadata: EDITOR_TOOL_DEFINITIONS.generateImage,
      description: 'Generate a real scene asset with GPT Image 2.5 Flare: backgrounds, textures, image fills, photos, isolated objects or transparent cut-outs. Build complete film frames, UI, typography, icons and vector graphics in scene code. Read launch-films-motions page image-plates first. Uses the shared OpenAI key/fallback, saves PNG project media with signed URLs, previews, references, provenance and visible estimated USD cost. Returns assetIds, signed assets[].url links, previews, quality and estimatedUsd (null when the provider reported too little usage to estimate it). Medium quality by default; low for exploration. count 1–4, up to four PNG/JPEG/WebP project-image references, and PNG alpha are supported; an edit of a transparent asset must still set transparentBackground: true. A failed call returns its actual cause: fix invalid input or missing access before retrying. Logos/icons use findIcon, hand-made shapes traceShape.',

      inputSchema: imageGenerationInput,
      execute: async (_ctx, request) => {
        const input = request;
        const references = [];
        for (const assetId of input.referenceAssetIds ?? []) {
          const asset = materializeTranscript(await ctx.runQuery(internal.assistant.getRunAsset, { ...run, assetId }));
          if (asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.contentType)) throw new Error(`${asset.fileName} is not a PNG, JPEG or WebP project image.`);
          if (asset.size > 50_000_000) throw new Error(`${asset.fileName} exceeds OpenAI's 50 MB reference image limit.`);
          const url = await mediaUrl(ctx, asset);
          if (!url) throw new Error(`${asset.fileName} has no readable image file.`);
          references.push(url);
        }
        await ctx.runMutation(internal.generatedImages.prepare, { ...run, count: input.count ?? 1 });
        const generated = await generateImagePlates(input, references, abortSignal), requestId = crypto.randomUUID();
        const { usage } = generated;
        console.log(`[ai-cost] ${JSON.stringify({ event: 'image-generation', ...run, requestId, model: IMAGE_MODEL, provider: 'openai.images', count: generated.images.length, ...usage })}`);
        await ctx.runMutation(internal.aiCosts.record, { projectId: run.projectId, runId: run.runId, ...options.publication, record: { key: `image-${requestId}`, kind: 'model-call', recordedAt: Date.now(), model: IMAGE_MODEL, provider: 'openai.images', reasoningEffort: null, speedMode: null, serviceTier: 'default', estimatedUsd: usage.estimatedUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTokens: null, uncachedInputTokens: usage.inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, toolCallCount: 1, unreportedCall: false } });
        const uploaded: { r2Key: string; size: number; width: number; height: number }[] = [];
        try {
          for (const image of generated.images) {
            abortSignal.throwIfAborted();
            const r2Key = newProjectMediaKey(run.ownerId, run.projectId);
            const size = await putMediaObject(r2Key, image.bytes, 'image/png');
            uploaded.push({ r2Key, size, width: image.width, height: image.height });
          }
          const saved = await ctx.runMutation(internal.generatedImages.save, { ...run, images: uploaded, provenance: { requestId, prompt: input.prompt, model: IMAGE_MODEL, size: imageGenerationSize(input), transparentBackground: input.transparentBackground ?? false, quality: imageGenerationQuality(input), referenceAssetIds: (input.referenceAssetIds ?? []) as Id<'assets'>[], usage } });
          assets.push(...saved);
          // Keep the MCP/action response bounded even for four detailed PNGs. Originals stay untouched in media.
          let previewBytes = 0;
          const images = generated.images.flatMap((image, index) => {
            if (index > 0 && previewBytes + image.data.length > 8_000_000) return [];
            previewBytes += image.data.length;
            return [{ label: `Generated plate ${index + 1}: ${saved[index]._id}`, data: image.data, mimeType: 'image/png' }];
          });
          return { assetIds: saved.map(asset => asset._id), assets: await Promise.all(saved.map(async asset => ({ assetId: asset._id, url: (await mediaUrl(ctx, asset))!, fileName: asset.fileName, width: asset.width, height: asset.height, ...generatedImageSummary(asset) }))), model: IMAGE_MODEL, quality: imageGenerationQuality(input), size: imageGenerationSize(input), estimatedUsd: usage.estimatedUsd, usage, images, ...(images.length < saved.length ? { previewNote: 'Large variants have limited inline previews; all variants are saved in project media.' } : {}), note: 'Saved to project media. Inspect the subject and edges, bind the chosen asset by name in scene media, and animate its wrapper with GSAP.' };
        } catch (error) {
          await ctx.runMutation(internal.generatedImages.cleanup, { ...run, keys: uploaded.map(image => image.r2Key) }).catch(() => {});
          throw error;
        }
      },
      toModelOutput: (ctx, options) => blueprintImages(ctx, options.output),
    }),
    discoverCapabilities: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.discoverCapabilities, description: 'Find relevant optional workflows or supporting skills by the needed action. Returns a short matching index, never full skill text. Shared edits need no discovery.', inputSchema: z.object({ query: z.string().trim().min(3).max(200) }), execute: async (_ctx, {query}) => ({ matches: discoverCapabilities(query, mcpSurface), next: 'Use loadCapability for a supporting workflow or readSkill for a skill. Change the primary style only if the deliverable changes.' }) }),
    loadCapability: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.loadCapability, description: 'Load supporting tools and a small skill index by a discovered workflow or skill name, without changing the primary style, task, clip delivery, finish checks or user decisions. Read only the needed skill pages afterward.', inputSchema: z.object({ name: z.string().trim().min(1).max(80) }), execute: async (_ctx, {name}) => ({ ...await loadCapability(name), primaryWorkflow: lane, next: 'Supporting capability loaded. Read needed skills; preserve the primary deliverable and finish it.' }) }),
    switchLane:createTool({metadata:EDITOR_TOOL_DEFINITIONS.switchLane,description:'Optionally change the primary workflow when the deliverable changes. Shared edits need no style selection. For supporting skills/tools use loadCapability instead, preserving the primary deliverable and finish checks.',inputSchema:z.object({lane:z.enum(LANE_IDS),reason:z.string().trim().min(5).max(300),taskType:z.enum(['edit','question'])}),execute:async(_ctx,input)=>{
      if(!taskId)throw new Error('Start a task first with startTask.');
      await laneCtx.runMutation(internal.lanes.switchLane,{...taskScope,timelineId,...input});
      lane=input.lane;laneChosen=true;finishRequired ||= input.taskType==='edit';requiredPersisted=finishRequired;finishResult=undefined;
      return {lane,instructions:laneInstructions(lane),checks:checkInstructions(lane,checkLevel),tools:availableToolNames()};
    }}),
    finish:createTool({metadata:EDITOR_TOOL_DEFINITIONS.finish,description:'Run this lane’s real completion checks. Takes no claimed scores or counts. Call before the final reply. Repair failures; after three failed checks stop and report their output honestly.',inputSchema:z.object({}).strict(),execute:async()=>{
      if(!taskId)throw new Error('Start a task first with startTask.');
      await editSession.wait();await ensureBaseline();
      if(lane==='reel'&&editSession.timeline.clips.some(clip=>clip.kind==='caption')){
        const audibleIds=new Set(editSession.timeline.clips.filter(clip=>clip.volume!==0&&(clip.kind==='audio'||clip.kind==='video'&&!clip.audioSeparated)).map(clip=>clip.assetId));
        // Each call starts with metadata rows; saved transcripts live in source analysis.
        await Promise.all(assets.filter(asset=>audibleIds.has(asset._id)||asset.audioAssetId&&audibleIds.has(asset.audioAssetId)).map(asset=>loadAsset(asset._id)));
      }
      if(lane==='clip')await selectClipQa();
      // Unviewed changed frames keep the task open the same way in the app and over MCP. The refusal spends no finish attempt.
      if(recipe().frames==='changes'&&!clippingActive){const missing=fastReview.feedback();if(missing)return {passed:false,success:false,attemptRecorded:false,pendingFrameTimes:fastReview.times(),next:missing};}
      const frameTask=recipe().frames==='sample'?await laneCtx.runQuery(internal.lanes.task,taskScope) as LaneTask:null;
      const durableFrames=frameTask?readFastFrameTimes(frameTask.evidence,timelineId,await timelineHistoryKey(editSession.timeline)):undefined;
      const check=()=>finishLane(laneCtx,{run,taskId,timelineId,timeline:editSession.timeline,assets,...(durableFrames!==undefined?{fastFrameTimes:fastReview.times()}:{}),clipping:()=>ctx.runQuery(internal.clipping.completionState,{...clippingRun,timeline:editSession.timeline,timelineId}),render:async(times,revision,target)=>{const result=await renderFrames(times,revision,target);if((!target||target===timelineId)&&revision===undefined)fastReview.reviewed(result.frames.map(frame=>frame.time),editSession.timeline);return result;},staged:editSession.staged});
      finishResult=await check();
      if(finishResult.passed){
        try{
          const checkedRevision=editSession.revision;
          await editSession.publish();
          // Publishing a draft advances the revision. Old motion checks cannot certify that new revision.
          if(editSession.revision!==checkedRevision&&referenceMotionEnabled()&&referenceMotionTargets(editSession.timeline,assets,timelineId,LANES[lane].referenceMotion==='required').length)finishResult=await check();
        }
        catch(error){finishResult=await laneCtx.runMutation(internal.lanes.recordFinish,{...taskScope,result:{...finishResult,passed:false,failures:[`The checked draft could not be saved: ${error instanceof Error?error.message:String(error)}`]}});}
      }
      console.info(`[ai-lane-finish] ${JSON.stringify({projectId:run.projectId,runId:run.runId,...finishResult})}`);
      return {...finishResult,success:finishResult.passed,next:finishResult.passed?'Checks passed. You may report the saved result.':finishResult.exhausted?'Stop. Report these failures honestly; this task is unfinished.':'Repair the listed failures and call finish again.'};
    }}),
    reportIssue: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.reportIssue,
      description: 'Report a Revline tool defect: wrong or inconsistent output, unexpected failure, or behavior contrary to its contract. Include a short input summary without user text, media, credentials or tokens, what happened and what you expected. Report once per defect, then continue safely or explain the limitation. Not for ordinary validation errors or unsupported requests.',
      inputSchema: z.object({ toolName: z.string().min(1).max(100), inputSummary: z.string().max(600), happened: z.string().min(1).max(1000), expected: z.string().min(1).max(1000) }),
      execute: async (_ctx, input) => {
        const incidentId = await ctx.runMutation(internal.incidents.reportAgent, { ...run, ...input });
        return incidentId ? { incidentId } : { incidentId: null, saved: false, next: 'The report limit is reached and this report was not saved. Do not retry; continue safely or explain the limitation.' };
      },
    }),
    listTimelines: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listTimelines, description: "List this project's timeline tabs, each a separate video sharing the project's sources. Editing tools act on the open tab.", inputSchema: z.object({}), execute: async () => ctx.runQuery(internal.assistant.listRunTimelines, run) }),
    createTimeline: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.createTimeline, description: "Create and open a blank timeline tab or duplicate the open tab. For clipping, use blank, the source aspect unless reframing was requested, and the clip's title. Publishes the current draft first; finish clipping directly after building accepted tabs; scoped heavy QA is optional. Never call alongside edits in parallel.", inputSchema: z.object({ from: z.enum(['blank', 'duplicate']), name: z.string().trim().min(1).max(60).optional(), aspectRatio: z.enum(['landscape', 'vertical', 'square']).optional() }), execute: async (_ctx, input) => switchTimeline(expectedRevision => ctx.runMutation(internal.assistant.createRunTimeline, { ...run, expectedRevision, ...input })) }),
    openTimeline: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.openTimeline, description: "Open an existing timeline tab by id from listTimelines. Publishes the current draft first; finish clipping directly after building accepted tabs; scoped heavy QA is optional. Changes the editor tab the user sees. Never call alongside edits in parallel.", inputSchema: z.object({ timelineId: z.string().min(1) }), execute: async (_ctx, input) => switchTimeline(expectedRevision => ctx.runMutation(internal.assistant.openRunTimeline, { ...run, expectedRevision, ...input })) }),
    importVideoLink: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.importVideoLink, description: "Import a YouTube or public media-file link into this project's Sources, keeping it off the timeline. Pass start and end in original SOURCE seconds when only a known section is needed; YouTube downloads only that window and the imported file starts at 0. Omit both for a whole-video import or whole-source clipping discovery. Returns taskId; poll getMediaTask until completed, then inspectTimeline to refresh sources. Reuse existing imports on retries.", inputSchema: z.object({ url: z.string().url(), start: z.number().min(0).optional(), end: z.number().positive().optional() }), execute: async (_ctx, input) => ctx.runMutation(internal.assistant.importRunVideo, { ...run, ...input }) }),
    getMediaTask: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getMediaTask, description: "Wait up to 30 seconds for an import, then return its status and resulting source assetId. Reuse the taskId while pending; wait for completed before analysis, then inspectTimeline to refresh media.", inputSchema: z.object({ taskId: z.string().min(1) }), execute: async (_ctx, { taskId }) => {
      const deadline=Date.now()+30_000;
      for(;;){
        abortSignal.throwIfAborted();
        const state=await ctx.runQuery(internal.assistant.runMediaTask,{...run,taskId});
        if(!['queued','running'].includes(state.status)||Date.now()>=deadline)return state;
        await new Promise(resolve=>setTimeout(resolve,Math.min(1500,deadline-Date.now())));
      }
    } }),
    exportVideo: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.exportVideo, description: "Render a saved timeline to MP4 only when explicitly requested. timelineId selects a tab from listTimelines; omit for the open tab. Call once per requested timeline. Finish all timeline edits before exporting.", inputSchema: z.object({ timelineId: z.string().min(1).optional(), ...EXPORT_SETTINGS_INPUT }), execute: async (_ctx, input) => {
      await verifyCurrentTimeline();
      await editSession.publish();
      return ctx.runMutation(internal.assistant.exportRunVideo, { ...run, ...input, resolution: input.resolution ?? 1080, fps: input.fps ?? 30, quality: input.quality ?? 'high' });
    } }),

    planEffects:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.planEffects,description:"Not for scene clips: verify their rendered frames with getFrames as launch-films-motions \"Before handing back\" lists; recreations also use compareReference and compareMotion. Scenes are never planned or reviewed as effects. Not for simple edits whose result is known from their settings: fades, crossfades or dissolves built from existing footage, opacity, volume, cuts, trims, moves, crops, layout and split screens. Apply those directly; never plan or previewRender them. Before an authorized effect or creative styling edit whose look must be judged (zoom punches, footage or texture effects, text looks), record one to eight concrete expectations: purpose, actual supported strength, timeline window/peak and anchor. Derive acceptance criteria from the current user request and decoded evidence; do not add new creative requirements. Subject readability means the requested object remains recognizable, not that fine print becomes legible unless the user explicitly asks for that. Describe the observed action literally: a hand-held object moving through the air is not evidence of unsupported free flight. If the requested opening is ambiguous, inspect it before claiming a hover or release. For observed action, use an evidenceId returned by this run's inspectVideo mapped match; never invent an impact. Markers and cuts must still exist. Requested-time anchors are for explicit requested timing. Include targetClipId for existing footage/text. No timeline edits, no approval question. Long looks can be reviewed in a short sample window. Calls add or update plans by ID and retain other plans and their output links, up to eight per run. Use a separate timed plan for each FX pulse with its actual start and full duration. Reviewed expectations stay fixed; other plans can still be corrected. To attach an output for review, pass previewRender bindings instead of rewriting the plan.",inputSchema:z.object({plans:z.array(effectPlanInput).min(1).max(8)}),execute:async(_ctx,{plans})=>{
      // Selecting an edit plan is explicit workflow intent, even while the
      // model corrects a rejected preflight before its first timeline write.
      await beginEditing();
      await editSession.wait();
      const sceneIds=new Set(editSession.timeline.clips.filter(clip=>clip.kind==='scene').map(clip=>clip.id));
      if(plans.some(plan=>[plan.targetClipId,plan.outputClipId,plan.anchor.kind==='cut'?plan.anchor.clipId:undefined].some(id=>id&&sceneIds.has(id))))return {planned:false,sceneTarget:true,note:sceneCheckNote,planIds:effectPlans.map(plan=>plan.id)};
      validateEffectPlan(plans,editSession.timeline,visualEvidence);
      const merged=mergeEffectPlans(effectPlans,plans);
      const originals=editSession.timeline.clips.filter(clip=>merged.some(plan=>(plan.outputClipId??plan.targetClipId)===clip.id));
      await ctx.runMutation(internal.compositionReview.savePlan,{...run,plans,originals});
      for(const plan of plans)if(!equalTimelineValue(effectPlans.find(previous=>previous.id===plan.id),plan))planBindings.delete(plan.id);
      effectPlans=merged;return {planned:true,planIds:plans.map(plan=>plan.id),totalPlans:effectPlans.length,revision:editSession.revision,saved:false,staged:editSession.staged};
    }}),
    previewRender:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.previewRender,description:"Not for scene clips. Review one or two planned effects using the actual composited timeline, the export frame-capture engine and an effect-disabled reference. Returns measured pixel differences, clip timing/text bounds and narrow Gemini observations about the recorded expectations, with uncertainty. Each selected expectation, including start/anchor/peak/return, must fit inside the same three-second sampled window. If two expectations span more than three seconds, review each planId separately; do not repeatedly submit the same out-of-window pair. After a failed check make one targeted correction; two nonpassing judgments stop that expectation. Reuse passed checks unless another edit changes their visible scope, then refresh only those affected. A rejected window or failed renderer is not a completed visual judgment. Finish planned edits before reviewing. Optional bindings attach each selected plan to its existing output clip without changing the plan or repeating a passed review. Each timed plan must describe exactly one matching FX clip and its full range; separate pulses need separate plans. Does not edit the timeline. Sparse stills cannot prove audio sync, continuous motion, exact between-sample contact, or the whole edit's taste. After a failed check, correct only that expectation and review the corrected result once. Do not repeat passed checks or loop on an unavailable service. If the final review still fails, name the unfinished expectation in the final reply and do not claim full completion.",inputSchema:z.object({planIds:z.array(z.string()).min(1).max(2),bindings:z.array(z.object({planId:z.string(),clipId:z.string()})).max(2).optional()}),execute:async(_ctx,{planIds,bindings:explicitBindings})=>reportAnalysisFailure(async()=>{
      await editSession.wait();
      if(reviewServiceMissing)return reviewUnavailableResult;
      // Without a recorded plan there is nothing to review; that is guidance, not a failed step.
      const selected=planIds.map(id=>effectPlans.find(plan=>plan.id===id));if(selected.some(plan=>!plan))return {reviewed:false,needsPlan:true,note:`Nothing is planned under that ID, so there is nothing to review. ${sceneCheckNote} For an effect edit, record it with planEffects first.`};
      if(explicitBindings&&(new Set(explicitBindings.map(binding=>binding.planId)).size!==explicitBindings.length||explicitBindings.some(binding=>!planIds.includes(binding.planId))))throw new Error('Bind each selected review plan at most once.');
      const known=planIds.flatMap(planId=>{const clipId=explicitBindings?.find(binding=>binding.planId===planId)?.clipId??planBindings.get(planId);return clipId?[{planId,clipId}]:[];});
      const bindings=effectReviewBindings(selected as EffectPlan[],editSession.timeline,known);
      let reviewId:Id<'compositionReviews'>|undefined;
      try{
        reviewId=await ctx.runMutation(internal.compositionReview.request,{...run,expectedRevision:editSession.revision,timeline:editSession.timeline,planIds,bindings});
        const deadline=Date.now()+180000;
        while(true){abortSignal.throwIfAborted();const review=await ctx.runQuery(internal.compositionReview.get,{...run,reviewId});
          // An environment without the review service cannot review; report it plainly instead of failing.
          if(review.status==='failed'&&/composition review is not configured|Gemini.*HTTP 402/i.test(review.error??'')){reviewServiceMissing=true;return {...reviewUnavailableResult,reason:review.error};}
          if(review.status==='failed')throw new AnalysisStepError(review.error??'Rendered review failed.');
          if(review.status==='completed'){const current=await ctx.runQuery(internal.assistant.getRunTimeline,run),stale=current.revision!==review.result?.revision;return {reviewed:!stale,stale,currentRevision:current.revision,scope:stale?'The timeline changed during review. Inspect the latest state; this receipt describes the earlier snapshot.':'Sampled composited timeline; no audio judgment',staged:editSession.staged,...review.result};}
          if(Date.now()>deadline)throw new AnalysisStepError('Rendered review exceeded its three-minute limit. Saved edits remain.');
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }finally{if(reviewId)await ctx.runMutation(internal.compositionReview.cancel,{...run,reviewId});}
    })}),
    duplicateClips:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.duplicateClips,description:"Copy explicitly identified existing clips to requested timeline seconds, or duplicate immediately after the latest selected end when at is omitted. Preserve source ranges, relative timing, appearance, audio settings and linked pairs. A linked video copy returns both new video and audio IDs. For a visual overlay, keep its video and mute its copied audio with setVolume volume:0; unlink first when removing only one member. Copy both neighboring sources together with a selected transition to remap its pair correctly. Uses the same free-layer placement as the editor; never reads the browser clipboard or invents media.",inputSchema:z.object({clipIds:clipIdsInput,at:z.number().min(0).optional()}),execute:async(_ctx,{clipIds,at})=>{
      let newClipIds:string[]=[];
      const saved=await checkpoint(t=>{for(const id of clipIds)find(t,id);const copies=copyTimelineClips(t,clipIds);const result=pasteTimelineClips(t,copies,at??Math.max(...copies.map(c=>c.start+c.duration)));newClipIds=result.ids;return result.timeline});
      return {...saved,newClipIds};
    }}),
    reorderLayer:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.reorderLayer,description:"Move a whole occupied or empty layer within its own V/visual, A/audio or FX/effects group, preserving all clip timing and shifting intervening layer numbers as in the editor. from/to are layer numbers, not clip IDs. Audio never becomes visual/FX; source media and linked timing remain.",inputSchema:z.object({group:z.enum(['visual','audio','effects']),from:z.number().int().min(1).max(24),to:z.number().int().min(1).max(24)}),execute:async(_ctx,{group,from,to})=>checkpoint(t=>reorderLayer(t,group,from,to))}),
    moveClips:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.moveClips,description:"Move an explicitly selected clip group by signed timeline timeDelta and/or layerDelta while retaining relative timing and reciprocal linked audio. Same free-layer collision/boundary behavior as a manual group drag. Preserve all source ranges and other clip controls; zero layerDelta preserves the group's layer positions.",inputSchema:z.object({clipIds:clipIdsInput,timeDelta:z.number().optional(),layerDelta:z.number().int().min(-24).max(24).optional()}).refine(input=>input.timeDelta!==undefined||input.layerDelta!==undefined,{message:'Specify a time or layer delta.'}),execute:async(_ctx,{clipIds,timeDelta,layerDelta})=>checkpoint(t=>{for(const id of clipIds)find(t,id);return moveSelectedClips(t,clipIds,timeDelta??0,layerDelta??0)})}),
    resizeClips:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.resizeClips,description:"Trim or extend one requested edge of an explicitly selected group by signed timeline delta seconds, snapped to project frames. Use side left or right; retain animation/audio phase and linked timing. Clamp at source bounds, neighboring clips and one-frame minimum exactly as the editor's edge drag; never invent source handles. Read actual resulting ranges from the saved result.",inputSchema:z.object({clipIds:clipIdsInput,side:z.enum(['left','right']),delta:z.number()}),execute:async(_ctx,{clipIds,side,delta})=>checkpoint(t=>{for(const id of clipIds)find(t,id);return resizeSelectedClips(t,assets.map(asset=>({...asset,url:null})),clipIds,side,delta)})}),
    setBlendMode:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setBlendMode,description:"Set the requested supported blend mode on exact footage/text clip IDs, preserving all other controls. Apply both sides of an existing transition atomically when changing their common blend; unequal transition blends are refused. Audio and FX clips cannot receive blend modes.",inputSchema:z.object({clipIds:clipIdsInput,blendMode:z.enum(BLEND_MODES)}),execute:async(_ctx,{clipIds,blendMode})=>checkpoint(t=>setClipBlendMode(t,clipIds,blendMode))}),
    undoLatestEdit:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.undoLatestEdit,description:"Undo the latest actually saved edit first, only before this turn has applied or staged any changes. Uses saved history, never a guessed replacement/source extension. Returns undone:false when there is no saved edit. Refreshes the working timeline; subsequent changes can be saved together as a new undo group. Inspect the restored clips before choosing targets. To go back to a known-good version of one clip (or a whole tab) from further back, use listRevisions and restoreClip (or restoreTimeline), not chains of undo: undo steps also take back later edits you may want to keep. Redo, playback and the clipboard live in the browser; no tool can reach them.",inputSchema:z.object({}),execute:async()=>{
      if (recovering && !inspected) throw new Error('Inspect the current timeline before continuing the saved edit.');
      let undone=false;
      const snapshot=await editSession.inspect(async()=>{
        if(editSession.savedEdits||editSession.staged)throw new Error('Undo the latest saved edit before making changes in this turn.');
        const result=await ctx.runMutation(internal.assistant.undoLatestEdit,{...run,expectedRevision:editSession.revision,overrideApproved:approvalOverride.active>0});undone=result.undone;return result;
      });
      return {...snapshot,undone,saved:undone,applied:undone,message:undone?'Latest saved edit undone.':'No saved edits to undo.',summary:summarizeTimeline(snapshot.timeline,assets)};
    }}),
    listRevisions:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listRevisions,description:"The project's saved history, newest first: every saved edit as a revision with its number, time, who made it (the agent's name, Revline agent, or Editor for the user), which tool, the clips it changed, a short summary and any attached fix and verification records. Reach for it whenever the user refers to an earlier version: \"bring back what we had\", \"it was better before\", \"undo what you did to the intro\", \"the old lockup\". Then look at a candidate with getFrames revision, and bring it back with restoreSection (one section of a film, keeping the rest), restoreClip (one whole clip) or restoreTimeline (the whole tab). Lists every tab's edits, or one tab's when timelineId is given; clipId narrows to one clip's edits in the open tab (or timelineId's). historyStartsAt is the oldest revision that can be restored. Pass revision to read one exact saved edit and its fix records.",inputSchema:z.object({clipId:z.string().min(1).max(100).optional(),revision:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}),execute:async(_ctx,{clipId,revision,limit})=>{
      return ctx.runQuery(internal.assistant.revisionHistory,{...run,limit:limit??20,...(clipId?{clipId}:{}),...(revision!==undefined?{revision}:{})});
    }}),
    diffScene:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.diffScene,description:"Compare one clip's saved scene code at two revisions from listRevisions. Returns a paged unified diff with old and new line ranges. Reads saved states, including a clip deleted since then, without editing or restoring anything. Pass nextOffset as offset for the next page, keeping the same revisions and context.",inputSchema:z.object({clipId:z.string().min(1).max(100),fromRevision:z.number().int().min(0),toRevision:z.number().int().min(0),offset:z.number().int().min(0).optional().describe('Character offset returned as nextOffset by the preceding page.'),limit:z.number().int().min(1).max(500).optional().describe('Maximum diff lines per page, also capped at 30,000 characters.'),context:z.number().int().min(0).max(10).optional()}),execute:async(_ctx,input)=>ctx.runQuery(internal.assistant.diffScene,{...run,...input})}),
    recordFix:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.recordFix,description:"Attach what a fix changed and how it was verified to the exact saved revision returned by the edit. Give the changed clipId, a short summary, and verification evidence with the checked revision, tools, times, results and any remaining discrepancy. This is an agent-authored record, not an automatic verification certificate. It does not edit the timeline or brief. Later turns read these records in listRevisions. A revision must have changed this clip on this tab; staged or unsaved edits cannot receive records.",inputSchema:z.object({clipId:z.string().min(1).max(100),revision:z.number().int().min(0),summary:z.string().trim().min(1).max(1000),verification:z.string().trim().min(1).max(4000)}),execute:async(_ctx,input)=>{
      await editSession.wait();
      if(editSession.staged)throw new Error('Save the staged edit and verify its saved revision before recording a fix.');
      return ctx.runMutation(internal.assistant.recordFix,{...run,...input});
    }}),
    restoreClip:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.restoreClip,description:"Put one clip back exactly as it was at an earlier revision (from listRevisions): scene code, media, text, timing, effects, everything. Every other clip stays as it is now. A clip deleted since then comes back. Saves as a new revision and is undoable. Use this, not chains of undoLatestEdit, to return a clip to a known-good version. keepTiming keeps the clip's current start, duration and layer (for when other clips moved into its old place). A video's linked audio is a separate clip: restore it too if its timing changed.",inputSchema:z.object({clipId:z.string().min(1).max(100),revision:z.number().int().min(0),keepTiming:z.boolean().optional()}),execute:async(_ctx,{clipId,revision,keepTiming})=>{
      await editSession.wait();
      const {change,timelineId}=await ctx.runQuery(internal.assistant.revisionChanges,{...run,revision,clipId}) as {timelineId:string;change:{changedAt:number;lastChangedAt:number;before:Clip|null;index?:number}|null};
      const now=editSession.timeline.clips.find(clip=>clip.id===clipId);
      if(!change){
        if(!now)throw new Error(`Clip ${clipId} is not on timeline ${timelineId} now and has no saved history there. Check the ID with listRevisions; for a clip in another tab, pass that timelineId.`);
        return {applied:false,saved:false,unchanged:true,message:`Clip ${clipId} has not changed since revision ${revision}; it already matches.`};
      }
      if(!change.before)throw new Error(`Clip ${clipId} did not exist yet at revision ${revision}: it was added at revision ${change.changedAt}. Pick revision ${change.changedAt} or later from listRevisions${now?', or delete the clip if it should go':''}.`);
      const target=keepTiming&&now?{...change.before,start:now.start,duration:now.duration,track:now.track}:change.before;
      try{
        const result=await checkpoint(t=>placeClip(t,target,change.index));
        return {...result,restored:{clipId,revision,timelineId,...(now?{}:{readded:true,deletedAt:change.lastChangedAt})},message:result.unchanged?`Clip ${clipId} already matches revision ${revision}.`:now?`Clip ${clipId} is back to revision ${revision}.`:`Clip ${clipId} was deleted at revision ${change.lastChangedAt}; it is back as it was at revision ${revision}.`};
      }catch(error){
        const text=error instanceof Error?error.message:String(error);
        throw new Error(/overlap/i.test(text)?`${text} At revision ${revision} the clip sat where another clip is now. Pass keepTiming:true to keep its current place, or move the other clip first.`:text);
      }
    }}),
    restoreTimeline:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.restoreTimeline,description:"Put the whole open timeline tab back to an earlier revision (from listRevisions): every clip and the tab's settings return to that state, clips added since are removed and deleted ones come back. Other tabs are untouched. Saves as a new revision and is undoable. Only when the user wants the whole tab back; for one scene or clip use restoreClip, which keeps later work on the other clips.",inputSchema:z.object({revision:z.number().int().min(0)}),execute:async(_ctx,{revision})=>{
      await editSession.wait();
      const {changes,timelineId}=await ctx.runQuery(internal.assistant.revisionChanges,{...run,revision}) as {timelineId:string;changes:{clipId:string;before:Clip|null;index?:number;rest?:Timeline}[]};
      if(!changes.length)return {applied:false,saved:false,unchanged:true,message:`Timeline ${timelineId} has not changed since revision ${revision}.`};
      const ordered=[...changes].sort((a,b)=>(a.index??Infinity)-(b.index??Infinity));
      const result=await checkpoint(t=>ordered.reduce<Timeline>((next,change)=>change.clipId===TIMELINE_ROW?(change.rest?{...change.rest,clips:next.clips}:next):change.before?placeClip(next,change.before,change.index):{...next,clips:next.clips.filter(clip=>clip.id!==change.clipId)},t));
      return {...result,restored:{revision,timelineId,clipsChanged:changes.filter(change=>change.clipId!==TIMELINE_ROW).length},message:result.unchanged?`Timeline ${timelineId} already matches revision ${revision}.`:`Timeline ${timelineId} is back to revision ${revision}.`};
    }}),
    restoreSection:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.restoreSection,description:"Bring back one section of a film as it was at an earlier revision while everything else stays as it is now: when the user says a part looked better before (\"bring back what we had in the intro\", \"the old lockup was better\", \"undo what you did to the ending\"). Find the revision with listRevisions (clipId narrows it to the film), look at it with getFrames revision, then pass the film's clipId, that revision and section: the section marker label or id, or a {start, end} range in film seconds. The section's section() calls and the declarations only they use come back from that revision; other sections, shared code and later edits stay. If code the section shares with other sections changed since then, nothing changes and the result names it: call again with includeShared: true to restore that too, and the visual guard refuses it if any other section would look different. Saves as a new revision and is undoable. For a whole clip use restoreClip.",inputSchema:z.object({clipId:z.string().min(1).max(100),revision:z.number().int().min(0),section:scopeInput,includeShared:z.boolean().optional().describe('Also restore declarations other sections share, when the section needs their older version.')}),execute:async(_ctx,{clipId,revision,section,includeShared})=>{
      await editSession.wait();
      const {change}=await ctx.runQuery(internal.assistant.revisionChanges,{...run,revision,clipId}) as {change:{changedAt:number;before:Clip|null}|null};
      const now=find(editSession.timeline,clipId);
      if(now.kind!=='scene'||!now.scene)throw new Error('Choose a film or scene clip.');
      if(!change)return {applied:false,saved:false,unchanged:true,message:`Clip ${clipId} has not changed since revision ${revision}; that section already matches.`};
      if(!change.before?.scene)throw new Error(`Clip ${clipId} did not exist as a scene at revision ${revision}: it was added at revision ${change.changedAt}. Pick a later revision from listRevisions.`);
      const old=change.before.scene;let restored:string[]=[];
      const apply=(t:Timeline)=>{const clip=find(t,clipId);if(!clip.scene)throw new Error('Choose a film or scene clip.');const result=restoreSectionCode(clip.scene,old,resolveScope(t,clip,section),includeShared);restored=result.restored;if(result.code===clip.scene.code)return t;checkSceneCode(result.code);return withPatchedScene(t,clip.scene.code,result.code).timeline;};
      const scoped=await scopedChange(clipId,section,apply,'restore');
      if('refusal' in scoped)return scoped.refusal;
      const result=await checkpoint(apply);
      return {...result,...scoped,restored:{clipId,revision,declarations:restored},message:result.unchanged?`That section already matches revision ${revision}.`:`The section is back as it was at revision ${revision}; the rest of the film is unchanged.`};
    },toModelOutput:(ctx,options)=>blueprintImages(ctx,options.output)}),
    readBrief:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.readBrief,description:"Read this project's brief: the user's lasting direction for this project (what to keep, what to avoid, style and pacing rules), one rule each with the user's own words. Read it before editing a project, and follow it.",inputSchema:z.object({}),execute:async()=>ctx.runQuery(internal.briefs.forRun,run)}),
    updateBrief:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.updateBrief,description:"Keep the project brief current whenever the user gives direction that should last beyond this one change: what they love and want kept (\"the lockup at 6.3 s is perfect\"), what to avoid, style or pacing rules. Each rule is one short instruction plus the user's own words, quoted. When new direction supersedes a rule (the user changed their mind or refined it), pass that rule's ruleId in replaces instead of adding a second rule beside it; remove drops rules the user withdrew. Not for one-off edit requests. Returns the whole brief.",inputSchema:z.object({set:z.array(z.object({rule:z.string().trim().min(3).max(300).describe('The direction as one short instruction.'),userWords:z.string().trim().min(1).max(600).describe('What the user said, quoted.'),replaces:z.array(z.string().min(1)).max(10).optional().describe('ruleIds this rule supersedes.')})).max(10).optional(),remove:z.array(z.string().min(1)).max(40).optional().describe('ruleIds the user withdrew.')}).refine(input=>input.set?.length||input.remove?.length,{message:'Give rules to set or ruleIds to remove.'}),execute:async(_ctx,{set,remove})=>ctx.runMutation(internal.briefs.update,{...run,set:(set??[]).map(item=>({rule:item.rule,words:item.userWords,...(item.replaces?.length?{replaces:item.replaces}:{})})),remove:remove??[]})}),
    unlink:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.unlink,description:"Unlink an identified video/audio pair while keeping both clips, media, source ranges, timing, volume and settings. After unlink, deleting/trimming/splitting only the video leaves its original audio independent. Select either pair member; preserve other clips. Does not enable the muted separated video's duplicate sound.",inputSchema:z.object({clipId:z.string().min(1).max(100)}),execute:async(_ctx,{clipId})=>{
      let clipIds:string[]=[];
      const result=await checkpoint(t=>{
        const clip=find(t,clipId);if(clip.kind!=='video'&&clip.kind!=='audio')throw new Error('Choose a video or audio clip to unlink.');
        if(!clip.linkedClipId)return t;
        const pair=find(t,clip.linkedClipId);if(pair.linkedClipId!==clip.id)throw new Error('Choose a reciprocal linked video/audio pair.');
        clipIds=[clip.id,pair.id];return unlinkClips(t,clipId);
      });
      return {...result,unlinked:clipIds.length>0,clipIds};
    }}),
    approveClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.approveClip, description: "Mark a clip, or one section of a film or scene, as approved: the user signed off on it, and every editing tool then refuses to change it. Use it when the user says they approve, like, or want to keep a clip or part of a film as it is. A section is a marker's part of a film (markerId: from that marker to the next) or a timeline range (start/end seconds) on a scene clip. note says what was approved, in the user's words (\"user approved the GeForce/CUDA diagrams\"). Approving a video approves its linked audio too. Call it only after the user approves; never approve on their behalf.", inputSchema: z.object({ clipId: z.string().min(1), markerId: z.string().min(1).optional().describe('Approve the film section that starts at this marker (to the next marker or the film end).'), start: z.number().min(0).optional().describe('Timeline seconds: approve only start..end of this scene or film clip.'), end: z.number().positive().optional(), note: z.string().trim().max(APPROVAL_NOTE_LIMIT).optional() }).refine(input => (input.start === undefined) === (input.end === undefined) && !(input.markerId && input.start !== undefined) && (input.start === undefined || input.end! > input.start), { message: 'Give markerId, or both start and end (end after start), or neither to approve the whole clip.' }), execute: async (_ctx, { clipId, markerId, start, end, note }) => {
      let section: { id: string; start: number; end: number; label?: string } | undefined;
      const saved = await checkpoint(t => {
        const clip = find(t, clipId);
        if (markerId === undefined && start === undefined) return approveClip(t, clipId, note, 'agent');
        const range = markerId ? markerSection(t, clip, markerId) : { start: start!, end: end! };
        const result = approveSection(t, clipId, range, note, 'agent');
        section = result.section;
        return result.timeline;
      });
      return { ...saved, approved: approvedWork({ ...editSession.timeline, clips: editSession.timeline.clips.filter(clip => clip.id === clipId) })[0], ...(section ? { sectionId: section.id } : {}) };
    } }),
    unapproveClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.unapproveClip, description: "Remove an approval so the clip (or one approved section, by sectionId from inspectClip) can be edited again. Only when the user asks to unlock or change approved work: reason quotes what they asked.", inputSchema: z.object({ clipId: z.string().min(1), sectionId: z.string().min(1).optional(), reason: z.string().trim().min(3).max(300).describe("What the user asked, in their words.") }), execute: async (_ctx, { clipId, sectionId }) => {
      const saved = await checkpoint(t => unapproveClip(t, clipId, sectionId));
      return { ...saved, unapproved: true, clipId, ...(sectionId ? { sectionId } : {}) };
    } }),
    inspectTimeline: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectTimeline, description: "Read this active project's current working timeline (the open timeline tab, named in openTimeline) and saved revision. If staged is true, this is a private replacement draft that has not been published yet. Expose each labeled layer with its group and number: FX effects-only, V video/image/text/solid-color, A audio. Timeline clips include their kind and track. Report visual coverage gaps, overlaps within the same group/layer, missing media references and effective text animation labels. Higher stacked layers are intentional and are not overlap errors. This tool does not change the timeline or create an undo entry. An animation field of none can still have motion keyframes or a text template: report the effective names from summary.textAnimations.", inputSchema: z.object({}), execute: async () => {
      const snapshot = await editSession.inspect(async () => {
        const current = await ctx.runQuery(internal.assistant.getRun, run);
        assets.splice(0,assets.length,...current.assets.map(asset=>{const previous=assets.find(item=>item._id===asset._id);return previous?.analysis&&previous.analysisId===asset.analysisId&&previous.analysisUpdatedAt===asset.analysisUpdatedAt?{...asset,analysis:previous.analysis}:asset;}));
        return { timeline: current.project.timeline ?? { clips: [], fps: 60, aspectRatio: current.project.aspectRatio }, revision: current.project.revision ?? 0 };
      });
      inspected = true;
      const captionedAssetIds=assets.filter(asset=>{
        const raw=asset.analysis?.transcript;
        if(!raw)return false;
        const transcript=asset.analysis?.audioActivity?refineTranscriptWithAudioActivity(raw,asset.analysis.audioActivity):raw;
        return captionsCoverTranscript(snapshot.timeline,asset._id,transcript);
      }).map(asset=>asset._id);
      const tabs = await ctx.runQuery(internal.assistant.listRunTimelines, run), requestedTab = boundRunTab(run.runId), openTab = tabs.find(tab => requestedTab ? tab.id === requestedTab : tab.active) ?? tabs[0];
      return { ...snapshot, openTimeline: { timelineId: openTab.id, name: openTab.name, otherTimelines: tabs.filter(tab => tab !== openTab).map(tab => tab.name) }, captionedAssetIds, assets: assets.map(({ _id, fileName, kind, duration, width, height, audioAssetId, imageGeneration }) => ({ assetId: _id, fileName, kind, duration, width, height, audioAssetId, ...generatedImageSummary({ imageGeneration }) })), timeline: modelTimeline(snapshot.timeline, selectedClipIds), layers: deriveTracks(snapshot.timeline), summary: summarizeTimeline(snapshot.timeline, assets), ...approvedNote(snapshot.timeline), brief: await ctx.runQuery(internal.briefs.forRun, run) };
    } }),
    inspectClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectClip, description: "Read one exact current clip including all motion/focus samples and settings omitted from the compact timeline. With no options, returns the full clip as before. For a short scene read, pass section (marker label or id), lines {start,end}, or both; sceneCode.blocks returns exact code and absolute numberedCode, plus the section block index. Line numbers are 1-based and inclusive for this revision; read ranges past either end are clamped and the returned bounds are reported. Scenes without identifiable sections use whole-scene line ranges. A film's section is its section('Name', start, duration, ...) call plus the top-level declarations it uses; the rest of the module is shared. search finds a literal string or per-line JavaScript regex with absolute line and column numbers and bounded previews, without returning the full code. Combine it with section or lines; use search.startLine to continue a page. Scoped reads omit full scene and blueprint code. Uses the working edit session; no edits. Read inspectTimeline first when fresh saved state is needed.", inputSchema: z.object({ clipId: z.string(), section: codeSectionInput.optional(), lines: z.object({ start: z.number().int(), end: z.number().int() }).strict().optional().describe('Inclusive read range; endpoints outside the source are clamped to its first or last line.'), search: z.object({ query: z.string().min(1).max(500), regex: z.boolean().optional(), caseSensitive: z.boolean().optional().describe('Case-insensitive by default; true matches exact case.'), startLine: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(100).optional() }).optional() }), execute: async (_ctx, input) => {
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId), soundRecipe = assets.find(item => item._id === clip.assetId)?.soundRecipe;
      /* A film's clips: every clip showing a window of this one code. */
      const filmClips = clip.scene?.film ? editSession.timeline.clips.filter(other => other.kind === 'scene' && other.scene?.code === clip.scene!.code).sort((a, b) => a.start - b.start).map(other => ({ clipId: other.id, title: other.scene!.title, start: other.start, duration: other.duration, filmTime: other.sourceStart })) : [];
      const result = { clip, ...(isApproved(clip) ? { approved: approvedWork({ ...editSession.timeline, clips: [clip] })[0], approvedRule: APPROVED_RULE } : {}), ...(filmClips.length ? { filmClips } : {}), ...(soundRecipe ? { soundRecipe: JSON.parse(soundRecipe) } : {}), revision: editSession.revision, staged: editSession.staged };
      if (input.section === undefined && input.lines === undefined && !input.search) return result;
      const sceneCode = input.search ? searchSceneCode(editSession.timeline, clip, input, input.search) : inspectSceneCode(editSession.timeline, clip, input);
      const { code, blueprints, ...scene } = clip.scene!;
      return { ...result, clip: { ...clip, scene: { ...scene, codeCharacters: code.length, ...(blueprints ? { blueprints: blueprints.map(({ code: body, ...blueprint }) => ({ ...blueprint, codeCharacters: body.length })) } : {}) } }, sceneCode };
    } }),
    detectFacecam:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.detectFacecam,description:'Detect the webcam OVERLAY panel and gameplay regions using local MediaPipe faces and temporally stable OpenCV rectangle edges in the media processor. No Gemini key is required. Returns normalized x/y/w/h rectangles, source sample times, confidence and explicit creator-only/gameplay-only/uncertain outcomes. Reuses saved source analysis. If no clear panel is found, use followSubject mode face or retain a wider view. Use applyLayout detectedRegions:true for automatic creator-top/gameplay-bottom crops; inspect layout changes between samples.',inputSchema:z.object({assetId:z.string()}),execute:async(_ctx,{assetId})=>{if(lane==='clip'){const state=await ctx.runQuery(internal.clipping.completionState,{...clippingRun});if(!('found' in state)||state.required&&state.accepted===0)throw new Error('Complete findHighlights and planClips before facecam framing. This reuses the discovered source instead of downloading it twice in parallel.');}const asset=await analyze(assetId,'facecam');return {assetId:asset._id,...asset.analysis?.facecam,...(asset.analysis?.facecam?.samples.some(s=>s.kind==='uncertain')?{fallback:'Use followSubject mode face for uncertain layouts; keep a wider frame if no face is visible.'}:{})};}}),
    analyzeMedia: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.analyzeMedia, description: "Request real analysis of this project's uploaded media through durable background jobs. Transcribe word-timed speech and audio energy/peaks, measure local scene cuts (mode shots, no Gemini), create a native Gemini video overview, measure music beats, track a visible face, or break down a reference video (mode reference: measured cuts, beats and moments (every change at 10 fps, motion inside a shot too, with M ids and the shot each falls in), every shot split into its parts, transitions, camera, title styles and the style worth borrowing; use it when the user shares footage to remake or to take style from, and read the remaking-videos skill first). mode track uses face detection only; for other objects and moving-camera footage use trackPoints and attachToTrack. Use inspectVideo with the actual user question to find specific visual moments; a generic overview is not an answer to every editing question. Modes facecam and speakers detect overlay regions and diarized active speakers with visible face positions in the worker. Scene understanding is optional: reuse a saved overview. New overviews run only after the editor opens and transcription confirms little meaningful speech. Speech footage uses transcript evidence instead. Skipped, pending or failed overviews return unavailable without waiting or retrying. Continue with transcript evidence and readFrames rather than reporting a provider error to the user. Saved results are usable immediately; never invent unavailable results. Measured shot cuts (mode shots) are observations: they do not identify punches or impact frames and can miss dissolves or flashes. Mode reference also writes the five-line style direction and the signatures (T1, T2: the moves that define the style).", inputSchema: z.object({ assetId: z.string(), mode: z.enum(["transcribe", "understand", "shots", "beats", "track", "reference", "facecam", "speakers"]),start:z.number().min(0).optional(),end:z.number().positive().optional() }).refine(i=>(i.start===undefined&&i.end===undefined)||(i.mode==='speakers'&&i.start!==undefined&&i.end!==undefined&&i.end>i.start&&i.end-i.start<=120),{message:'Source start/end windows are for speaker analysis, up to 120 seconds.'}), execute: async (_ctx, input) => {
      return reportAnalysisFailure(async () => {
      const asset = input.mode === 'understand' ? await loadAsset(input.assetId) : await analyze(input.assetId, input.mode,false,input.start!==undefined&&input.end!==undefined?{start:input.start,end:input.end}:undefined);
      if (input.mode === 'understand' && !asset.analysis?.understanding) return understandingUnavailable(input.assetId);
      return { analyzed: true, assetId: asset._id, mode: input.mode, ...(input.mode==='facecam'?{facecam:asset.analysis?.facecam}:{}), ...(input.mode==='speakers'?{start:asset.analysis?.speakers?.start,end:asset.analysis?.speakers?.end,identityScope:asset.analysis?.speakers?.identityScope,turnCount:asset.analysis?.speakers?.turns.length,framing:asset.analysis?.speakers?summarizeSpeakerFraming(asset.analysis.speakers,input.start,input.end):null,readTool:'inspectAssetAnalysis with start/end SOURCE seconds'}:{}), ...(input.mode === "transcribe" ? { segmentCount: asset.analysis?.transcript?.segments.length, wordCount: asset.analysis?.transcript?.words.length } : {}), ...(input.mode === "understand" ? { summary: asset.analysis?.understanding?.summary, sceneCount: asset.analysis?.understanding?.scenes.length } : {}), ...(input.mode === "beats" ? { bpm: asset.analysis?.beats?.bpm, sectionCount: asset.analysis?.beats?.beats.length, downbeatCount: asset.analysis?.beats?.downbeats?.length ?? 0, accentCount: asset.analysis?.beats?.accents?.length ?? 0, dropCandidateCount: asset.analysis?.beats?.dropCandidates?.length ?? 0, engine: asset.analysis?.beats?.engine, confidence: asset.analysis?.beats?.confidence } : {}), ...(input.mode === "track" ? { sampleCount: asset.analysis?.focus?.length } : {}), ...(input.mode === "reference" ? referenceSummary(asset) : {}) };
      });
    } }),
    inspectReference: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectReference, description: "Read a saved reference breakdown (analyzeMedia mode reference). Without selectors it returns the overview: genre, rhythm, the five-line style direction, signatures and one line per shot. Select what the user pointed at by shot ids (S4), part ids (S4.title), signature ids (T2), a SOURCE time (the shot playing then) or a part kind (every title) to get full detail: transition, camera, look, each part with its box and motion, and title styles. Resolve phrases like 'the second transition' or 'the title at 0:07' here before building. No timeline changes.", inputSchema: z.object({ assetId: z.string(), shotIds: z.array(z.string()).max(40).optional(), partIds: z.array(z.string()).max(40).optional(), signatureIds: z.array(z.string()).max(8).optional(), time: z.number().min(0).optional(), partKind: z.enum(REFERENCE_PARTS).optional() }), execute: async (_ctx, input) => {
      const asset = await loadAsset(input.assetId), reference = readReference(asset.analysis?.reference);
      if (!reference) throw new Error('This video has no reference breakdown yet. Run analyzeMedia with mode reference first.');
      const wanted = new Set([...(input.shotIds ?? []), ...(input.partIds ?? []).map(id => id.split('.')[0])].map(id => id.trim().toUpperCase()));
      const signatures = reference.signatures.filter(signature => input.signatureIds?.some(id => id.trim().toUpperCase() === signature.id));
      for (const signature of signatures) for (const id of signature.shotIds) wanted.add(id);
      if (input.time !== undefined) { const shot = reference.shots.find(item => input.time! >= item.start && input.time! < item.end) ?? reference.shots.at(-1)!; wanted.add(shot.id); }
      const parts = new Set((input.partIds ?? []).map(id => id.trim().toUpperCase()));
      const shots = reference.shots.filter(shot => wanted.has(shot.id) || (input.partKind && shot.parts.some(part => part.kind === input.partKind)));
      if (!shots.length && !input.partKind && !wanted.size && !signatures.length) return referenceSummary(asset);
      return { assetId: asset._id, ...(signatures.length ? { signatures } : {}), shots: shots.map(shot => { const named = shot.parts.filter(part => parts.has(part.id.toUpperCase())); return { ...shot, parts: (named.length ? named : shot.parts).filter(part => !input.partKind || part.kind === input.partKind) }; }), missing: [...wanted].filter(id => !reference.shots.some(shot => shot.id === id)) };
    } }),
    inspectVideo: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectVideo, description: "Optional Gemini inspection. If available:false is returned, the reason explains provider billing/access or the outage: do not retry other windows or inspectFrames in this run; use transcript/voice for spoken moments, and leave unsupported visual action unresolved rather than claiming stills/cuts prove it. Ask Gemini to dynamically inspect this uploaded native video for the user's actual visual question, such as finding fights, a reaction, a punch or an object. Never use it for trims, cuts, take selection or removing repeats and pauses unless the user explicitly asked for a visual check (watching the footage, eyes-to-camera, awkward look-ups). For clipping, start/end are required SOURCE seconds with at most 60 seconds per candidate; only that window is uploaded, so ask about a window of up to about 60 seconds around the candidate moments (one question per line or take). Whole-source questions on long footage are slow and can outlast this edit. Use the transcript, not this tool, to find which words were said and where. Returns relevant source-time windows, an answer, honest uncertainty, and matches mapped onto retained timeline clips. Zero matches is valid. No timeline changes. Times are approximate visual evidence, never invented frame indices or sample counts. In clipping, one batch allows at most 12 distinct windows and 600 source seconds; repeating an identical window reuses its saved observation.", inputSchema: z.object({ assetId: z.string(), question: z.string().min(1).max(MAX_INSPECTION_QUESTION), start: z.number().min(0).optional(), end: z.number().positive().optional() }), execute: async (_ctx, input) => {
      const asset = assets.find(item => item._id === input.assetId);
      if (asset?.kind !== 'video' || !asset.duration) throw new Error('Choose a video source from this project.');
      const videoRequest = { question: input.question.trim(), start: input.start ?? 0, end: input.end ?? asset.duration };
      if (lane === 'clip' && (input.start === undefined || input.end === undefined || input.end-input.start > 60))
        throw new Error('Clipping inspects explicit candidate SOURCE windows of at most 60 seconds, never the whole source by default.');
      validateVideoInspectionInput(videoRequest, asset.duration);
      const reservation = lane === 'clip' ? await ctx.runMutation(internal.clipping.reserveVisual, { ...clippingRun, assetId: asset._id, ...videoRequest }) : null;
      if (reservation?.cached) return { assetId: asset._id, ...reservation.cached, cached: true, scope: reservation.cached.available === false ? 'Cached unavailability; no visual observation was obtained.' : 'Saved targeted native-video observation; source times only.' };
      if (reservation?.pending) return { available: false, reason: 'This exact video window is already being inspected. Reuse its observation after completion; do not duplicate the request.' };
      const output = await optionalVideoInspection(() => withAnalysis(input.assetId, 'video', async request => {
        if (!request.videoInspection) throw new Error('Native video inspection completed without saved evidence.');
        await editSession.wait();
        const evidence = request.videoInspection;
        return { assetId: input.assetId, ...evidence, matchCount: evidence.matches.length, timelineOccurrences: editSession.timeline.clips.filter(clip => clip.kind === 'video' && clip.assetId === input.assetId).map(clip => ({ clipId: clip.id, sourceStart: clip.sourceStart, timelineStart: clip.start, duration: clip.duration, playbackRate: playbackRateOf(clip), matches: videoMatchesOnClip(evidence, clip).map(match=>{const evidenceId=crypto.randomUUID();visualEvidence.set(evidenceId,{clipIds:[clip.id],start:match.timelineStart,end:match.timelineEnd});return {...match,evidenceId};}) })) };
      }, { videoRequest }));
      if (reservation?.token) await ctx.runMutation(internal.clipping.recordVisual, { ...clippingRun, token: reservation.token, result: JSON.stringify({ ...output, timelineOccurrences: undefined }) });
      return output;
    } }),
    inspectFrames: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectFrames, description: "Inspect decoded timestamped images near an audio/transcript candidate or observed visual event for precise visual cleanup, such as checking a script glance. For speech cuts and take selection use it only when the user explicitly asked for a visual check such as eye contact or awkward look-ups. Required start/end are SOURCE seconds, a focused window up to three seconds, with at most twelve actual frames. Use precision consecutive to verify a suspected brief glance or cut boundary: first localize the candidate, then use the returned narrow refinement window with the same focused question. Skipped frames cannot pass this precision check. Never scan every cut automatically. Returns observations, uncertainty, sampling gaps and exact source/timeline positions for retained frames. Sparse images cannot prove continuous motion, speech absence, audio sync or unseen event boundaries. For a named zoom target such as a modal/button/cursor, ask to locate that target: returned targets include source-coordinate boxes and current-request targetIds. Use targetId with configureSmoothZoom or configureCameraMotion; never guess coordinates. For sampled cursor/object following inspect distinct source instants; returned source/timeline times bind each location to an actual decoded frame. Inspect a relevant nearby frame, not every frame or a fixed padding window. No timeline changes; preserve speech using word timings and measured audio before cutting.", inputSchema: z.object({ assetId: z.string(), question: z.string().trim().min(1).max(1000), start: z.number().min(0), end: z.number().positive(), precision: z.enum(['sampled', 'consecutive']).optional() }), execute: async (_ctx, input) => {
      const asset = assets.find(item => item._id === input.assetId);
      if (asset?.kind !== 'video' || !asset.duration) throw new Error('Choose a video source from this project.');
      const frameRequest = { start: input.start, end: input.end, question: input.question.trim() };
      validateFrameInspectionInput(frameRequest, asset.duration);
      return optionalVideoInspection(() => withAnalysis(input.assetId, 'frames', async request => {
        if (!request.frameInspection) throw new Error('Frame inspection completed without saved evidence.');
        await editSession.wait();
        const evidence = request.frameInspection;
        const coverage = frameInspectionCoverage(evidence);
        if (input.precision === 'consecutive') {
          try { assertConsecutiveInspection(evidence); }
          catch (error) { return { success:false as const, code:'FRAME_REFINEMENT_REQUIRED', error:(error as Error).message, assetId:input.assetId, coverage }; }
        }
        const targets=rememberZoomTargets(evidence,input.assetId,zoomTargets);
        return { assetId: input.assetId, ...evidence,targets, coverage, precision: input.precision ?? 'sampled', inspectedFrameCount: evidence.frames.length, scope: 'Decoded still images only; timestamps identify sampled frames, not continuous event boundaries or audio evidence.', timelineOccurrences: editSession.timeline.clips.filter(clip => clip.kind === 'video' && clip.assetId === input.assetId).map(clip => ({ clipId: clip.id, sourceStart: clip.sourceStart, timelineStart: clip.start, duration: clip.duration, playbackRate: playbackRateOf(clip), ...frameEvidenceOnClip(evidence, clip) })).filter(clip => clip.frames.length > 0) };
      }, { frameRequest }));
    } }),
    editText: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.editText, description: "Change an existing caption or graphic's text and save immediately. Preserve its timing and style. With saved speech evidence, captions must match the measured phrase inside that timing; case and punctuation corrections are allowed. Use setCaptionTiming first when moving phrase boundaries; never add unspoken words.", inputSchema: z.object({ clipId: z.string(), text: z.string().max(2000) }), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId); if (clip.kind !== "caption" && clip.kind !== "graphic") throw new Error("Choose a caption or text graphic");
      if (clip.kind === 'caption') {
        const words = retainedSpeechWords(t, assets);
        const mismatch = words.length ? captionSyncFailures({ ...t, clips: [{ ...clip, text: input.text }] }, words, { checkCoverage: false })[0] : undefined;
        if (mismatch) throw new Error(`${mismatch} Keep that measured phrase, or use setCaptionTiming to realign its boundaries before editing the text.`);
      }
      return patchClip(t, input.clipId, { text: input.text });
    }) }),
    styleCaptions: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.styleCaptions, description: "Batch-style existing captions and text graphics using exact clipIds. Without IDs, target captions only. Compose a custom style with installed font, size, weight, italic, spacing, line height, alignment, text-box padding/radius, solid colors, position, rotation, blend, stroke/shadow/glow and optional textCase in one call. Presets are optional starting points, not a requirement. Preserve words unless textCase is explicitly requested, and always preserve timing. Preserve its animation unless explicitly supplied; animation replaces the prior selection independently of appearance. Save immediately.", inputSchema: z.object({ clipIds: z.array(z.string()).min(1).max(200).optional(), fontSize: z.number().min(8).max(300).optional(),fontFamily:fontFamily.optional(), color: textColor.optional(), background: textColor.optional(), blendMode: z.enum(BLEND_MODES).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), rotation:z.number().min(-360).max(360).optional(),textStyle:textStyleInput.optional(), textCase:z.enum(['sentence','upper','lower']).optional(), animation:z.enum(TEXT_ANIMATION_PRESETS).optional() }), execute: async (_ctx, input) => checkpoint(t => {
      const {clipIds,animation,...style}=input;
      const hasStyle=Object.values(style).some(value=>value!==undefined);
      if(!hasStyle&&animation===undefined)throw new Error('Specify a caption style or animation control.');
      const next=hasStyle?(clipIds?patchTextStyles(t,style,clipIds):patchCaptionStyles(t,style)):t;
      if(animation===undefined)return next;
      if(clipIds?.some(id=>!['caption','graphic'].includes(find(next,id).kind)))throw new Error('Choose caption or text graphic clips only.');
      const selected=new Set(clipIds??next.clips.filter(clip=>clip.kind==='caption').map(clip=>clip.id));
      if(!selected.size)throw new Error('This timeline has no saved captions.');
      return {...next,clips:next.clips.map(clip=>selected.has(clip.id)?{...clip,...textAnimationPatch(clip,animation)}:clip)};
    }) }),
    styleTextClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.styleTextClip, description: "Style a selected caption/text graphic's requested font, size, solid colors, position, rotation, animation or blend. Preserve omitted controls, words and timing. Appearance and animation are separate; an explicit animation replaces the prior selection. Save immediately.", inputSchema: z.object({ clipId: z.string(), fontSize: z.number().min(8).max(300).optional(),fontFamily:fontFamily.optional(), color: textColor.optional(), background: textColor.optional(), blendMode: z.enum(BLEND_MODES).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), rotation:z.number().min(-360).max(360).optional(), textStyle:textStyleInput.optional(), animation:z.enum(TEXT_ANIMATION_PRESETS).optional() }), execute: async (_ctx, input) => checkpoint(t => {
      const { clipId, rotation,animation, ...style } = input; const clip = find(t, clipId);
      if (clip.kind !== "caption" && clip.kind !== "graphic") throw new Error("Choose a caption or text graphic");
      if (rotation===undefined&&animation===undefined&&!Object.values(style).some(value => value !== undefined)) throw new Error("Specify a text style change");
      const next=rotation!==undefined||Object.values(style).some(value=>value!==undefined)?patchTextStyles(t,{...style,...(rotation!==undefined?{rotation}:{})},[clipId]):t;
      return animation!==undefined?patchClip(next,clipId,textAnimationPatch(find(next,clipId),animation)):next;
    }) }),
    setTextGradient:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setTextGradient,description:"Set static or animated gradient fill on exact caption/text-graphic clipIds, batching matching settings in one call. enabled:false restores the saved solid color. Use2–5 hex colors and angle0–360deg. Optional animation enabled:true moves the gradient inside stationary or independently moving letters; duration.2–60 is seconds per pass, direction forward/reverse, loop:true smoothly moves back and forth. animation enabled:false freezes to a static full-width gradient. Omitted controls preserve current gradient settings; enabling a new gradient defaults white/purple90deg. Preserve words, backgrounds, font, text movement, word timing, and clip duration. No footage analysis needed for known editable text. Karaoke's active-word highlight remains readable; other main lettering receives gradient fill, while accent echoes/outlines keep their colors.",inputSchema:z.object({clipIds:clipIdsInput,enabled:z.boolean(),colors:z.array(textColor.refine(color=>color!=='transparent')).min(2).max(5).optional(),angle:z.number().min(0).max(360).optional(),animation:z.object({enabled:z.boolean(),duration:z.number().min(.2).max(60).optional(),direction:z.enum(['forward','reverse']).optional(),loop:z.boolean().optional()}).strict().optional()}).strict(),execute:async(_ctx,{clipIds,...changes})=>checkpoint(t=>{const patches=new Map(clipIds.map(id=>[id,textGradientPatch(find(t,id),changes)]));return {...t,clips:t.clips.map(clip=>patches.has(clip.id)?{...clip,...patches.get(clip.id)}:clip)};})}),
    setTextStyle:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setTextStyle,description:"Design a caption/text graphic appearance from individual controls, without selecting a preset: fontWeight100..900 (clamped to the installed face), italic, letterSpacing -10..100px, lineHeight .5..3, textAlign left/center/right, paddingX/Y and borderRadius0..200px, plus stroke, shadow and glow. Pixel values use a 1080 shorter output dimension; 0 width/blur disables that feature. Colors are six-digit hex. Preserve omitted controls, words, timings, fonts, position, rotation and independent text animation. Saves immediately.",inputSchema:textStyleInput.extend({clipId:z.string()}).refine(input=>Object.entries(input).some(([key,value])=>key!=='clipId'&&value!==undefined),{message:'Specify a text appearance control.'}),execute:async(_ctx,{clipId,...changes})=>checkpoint(t=>{const clip=find(t,clipId);if(clip.kind!=='caption'&&clip.kind!=='graphic')throw new Error('Choose a caption or text graphic.');return patchClip(t,clipId,{textStyle:{...resolvedTextAppearance(clip),...changes}})})}),
    applyTextLook:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyTextLook,description:"Apply a requested text look, or one justified by authorized creative text styling, to a caption/graphic. Styles set solid fill/background/size/blend/stroke/shadow/glow only. Every style preserves the existing animation, custom motion, effect color, strength, timing, stagger and word timings. Default text resets appearance only; Neon Echo does not add or replace motion. Words, clip timing, position, rotation and font remain. Use setTextAnimation only when the user requests an animation change.",inputSchema:z.object({clipId:z.string(),look:z.enum(TEXT_LOOKS.map(look=>look.id))}),execute:async(_ctx,{clipId,look})=>checkpoint(t=>patchClip(t,clipId,textLookPatch(find(t,clipId),look)))}),
    setTextAnimation:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setTextAnimation,description:"Choose a supported caption/graphic animation independently of text appearance: None, Fade, Rise, Pop in, Word reveal, Pop-in words, Sliding title, Karaoke, Neon Echo, Lyric Slam, Kinetic Stack, Chromatic split, Outline trails, Cinematic focus, Character scramble, Spotlight sweep, Ink write-on or Echo tunnel. Replace the prior animation, preserve words/style/font/rotation/timing. Karaoke preserves saved speech-word timings when present; otherwise it uses even duration progress, not detected syllables or beat sync.",inputSchema:z.object({clipId:z.string(),animation:z.enum(TEXT_ANIMATION_PRESETS)}),execute:async(_ctx,{clipId,animation})=>{const saved=await checkpoint(t=>patchClip(t,clipId,textAnimationPatch(find(t,clipId),animation)));return {...saved,effectiveAnimation:TEXT_ANIMATION_LABELS[animation]}}}),
    applyCaptionStyle:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyCaptionStyle,description:"Caption clips only: copy an existing caption's appearance to all saved captions, or exact caption targetClipIds. For graphic titles use styleCaptions with exact clipIds instead. Copy font, size, solid colors, position, rotation, blend, stroke/shadow/glow only. Every target keeps its own words, timing and animation. No transcription or new captions.",inputSchema:z.object({sourceClipId:z.string(),targetClipIds:z.array(z.string()).min(1).max(200).optional()}),execute:async(_ctx,{sourceClipId,targetClipIds})=>checkpoint(t=>applyCaptionStyle(t,sourceClipId,targetClipIds))}),
    setCaptionTiming:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setCaptionTiming,description:"Set an existing caption's absolute timeline start/end in seconds, snapped to project frames. Preserve its spoken words and original animation phase; do not generate text, move footage or change neighboring captions. Refuse ranges shorter than one frame or overlapping another clip on its V track.",inputSchema:z.object({clipId:z.string(),start:z.number().min(0).optional(),end:z.number().min(0).optional()}).refine(input=>input.start!==undefined||input.end!==undefined,{message:'Specify caption start or end.'}),execute:async(_ctx,{clipId,...range})=>checkpoint(t=>updateCaptionTiming(t,clipId,range))}),
    normalizeAudio:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.normalizeAudio,description:'Set enabled:false to remove saved normalization immediately without processing. Finish a clip or timeline at social loudness, default -14 LUFS integrated with true peak no higher than -1 dBTP. The media worker measures the retained mix with speed, gain, fades and ducking, runs two-pass loudnorm and verifies stored PCM. Preview and export use the SAME normalized WAV. clipId targets linked sound when selecting a video; omit for the whole timeline (up to ten minutes). Clip normalization bakes sound controls into its audio source, preserving its original source, transcript, ID and video link. Changes to the clip or ducking coverage automatically bypass the old bake. Timeline normalization plays a verified master while preserving the editable original mix. Later timing or mix edits bypass the master until normalized again. Finish timing/mix first; later edits require normalization again. Silent or unmeasurable audio fails without editing.',inputSchema:z.object({clipId:z.string().min(1).optional(),enabled:z.boolean().optional(),targetLufs:z.number().min(-24).max(-9).optional(),truePeak:z.number().min(-6).max(-1).optional()}),execute:async(_ctx,input)=>{
      await editSession.wait();
      const frozen=JSON.stringify(editSession.timeline),selected=input.clipId?find(editSession.timeline,input.clipId):undefined;
      const target=selected?.kind==='video'&&selected.linkedClipId?find(editSession.timeline,selected.linkedClipId):selected;
      if(target&&target.kind!=='audio')throw new Error('Choose an audio clip or a video with linked sound.');
      if(input.enabled===false)return checkpoint(t=>target?{...t,clips:t.clips.map(c=>c.id===target.id?{...c,normalizedAudio:undefined}:c)}:{...t,audioNormalization:undefined});
      const cached=target?.normalizedAudio??(!target?editSession.timeline.audioNormalization:undefined),cacheKey=target?audioNormalizationKey(editSession.timeline,target):timelineNormalizationKey(editSession.timeline);
      if(cached?.outputLufs!==undefined&&cached.measuredTruePeak!==undefined&&cached.key===cacheKey&&cached.targetLufs===(input.targetLufs??-14)&&cached.truePeak===(input.truePeak??-1))return {applied:false,alreadyNormalized:true,assetId:cached.assetId,targetLufs:cached.targetLufs,truePeakCeiling:cached.truePeak};
      const timelineId=boundRunTab(run.runId),snapshotId=await ctx.runMutation(internal.mcp.requestFrames,{ownerId:run.ownerId,projectId:run.projectId,recreation:recreationRender(),...(editSession.staged?{runId:run.runId}:{}),...(timelineId?{timelineId}:{}),times:[],normalization:{...(input.clipId?{clipId:input.clipId}:{}),targetLufs:input.targetLufs??-14,truePeak:input.truePeak??-1}});
      try{
        const deadline=Date.now()+540_000;
        while(true){
          abortSignal.throwIfAborted();
          const state=await ctx.runMutation(internal.mcp.takeFrames,{ownerId:run.ownerId,snapshotId});
          if(state.status==='failed')throw new AnalysisStepError(state.error??'Loudness normalization failed.');
          if(state.status==='completed'){
            const result=state.normalization;
            if(!result)throw new Error('The normalized audio result is missing.');
            await adoptAsset(result.assetId);
            const saved=await checkpoint(t=>{
              if(JSON.stringify(t)!==frozen)throw new Error('The timeline changed during normalization. Normalize its current mix again.');
              if(target)return {...t,clips:t.clips.map(c=>c.id===target.id?{...c,normalizedAudio:{assetId:result.assetId,key:audioNormalizationKey(t,c),targetLufs:input.targetLufs??-14,truePeak:input.truePeak??-1,outputLufs:result.outputLufs,measuredTruePeak:result.truePeak}}:c)};
              return {...t,audioNormalization:{assetId:result.assetId,key:timelineNormalizationKey(t),targetLufs:input.targetLufs??-14,truePeak:input.truePeak??-1,outputLufs:result.outputLufs,measuredTruePeak:result.truePeak}};
            });
            const current=target?editSession.timeline.clips.find(c=>c.id===target.id):undefined;
            const baked=target?current?.normalizedAudio:editSession.timeline.audioNormalization;
            const key=current?audioNormalizationKey(editSession.timeline,current):timelineNormalizationKey(editSession.timeline);
            if(baked?.key!==key)return {...saved,normalized:false,stale:true,note:'The sound changed concurrently. The old normalization is bypassed; normalize the current mix again.'};
            return {...saved,normalized:true,loudness:result,note:target?'Sound settings are baked into this clip. Normalize again after changing timing or mix.':'The normalized mix plays in preview and export. Later timing or mix edits automatically bypass it; normalize again when finished.'};
          }
          if(Date.now()>deadline)throw new AnalysisStepError('Loudness normalization is still processing. Try again when the worker finishes.');
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }finally{await ctx.runMutation(internal.mcp.discardFrames,{snapshotId});}
    }}),
    configureAudio:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureAudio,description:"Configure explicitly requested audio fades/role or lower music under voice clips. A linked video targets its separate audio. role original/voice/music is a user label, never inferred speech detection. Only music with ducking.enabled is attenuated during audible voice-labeled clip coverage; amount 0..1 is attenuation, attack/release seconds shape entry/recovery. Fades are timeline seconds at clip edges; preserve source/playback rate/timing/volume and omitted controls. No analysis is needed.",inputSchema:z.object({clipId:z.string(),role:z.enum(AUDIO_ROLES).optional(),fadeIn:z.number().min(0).max(AUDIO_LIMITS.fadeIn[1]).optional(),fadeOut:z.number().min(0).max(AUDIO_LIMITS.fadeOut[1]).optional(),ducking:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(1).optional(),attack:z.number().min(0).max(AUDIO_LIMITS.attack[1]).optional(),release:z.number().min(0).max(AUDIO_LIMITS.release[1]).optional()}).refine(input=>Object.values(input).some(value=>value!==undefined),{message:'Specify a music ducking control.'}).optional()}).refine(input=>Object.entries(input).some(([key,value])=>key!=='clipId'&&value!==undefined),{message:'Specify an audio control.'}),execute:async(_ctx,{clipId,...changes})=>checkpoint(t=>configureAudio(t,clipId,changes))}),
    setVolume: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setVolume, description: "Set volume from 0 (muted) through 1 (100%, original volume) to 2 (200%, boosted). A linked video controls its separate audio clip.", inputSchema: z.object({ clipId: z.string(), volume: z.number().min(0).max(2) }), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId); if (clip.kind !== "video" && clip.kind !== "audio") throw new Error("Choose a video or audio clip"); return patchClip(t, clip.id, { volume: input.volume });
    }) }),
    addSubtitlesFromTranscript: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addSubtitlesFromTranscript, description: "Add readable captions from this asset's saved transcript to each retained source occurrence. Creates minimal static phrases of at most six words with NO background, synchronized to retained speech. In the clip lane the default style is clipper instead: uppercase Montserrat Black, white with a black outline and no background, 1–3 words per caption, each word popping in as spoken with the active word in green; it needs saved word timings, and sentence-only transcripts get minimal captions. Pass style to override the lane default only when the user asks for the other look. Source trims and playback speed map their exact timings. Discarded words never reappear. Respect explicit no-captions or requested styling, changing only newly returned caption IDs. Without word evidence, only fully retained sentence segments can be captioned; partial segment text is never guessed. Never invent spoken text. Caption timing uses a conservative copy of the retained word timings; the saved provider timings never change.", inputSchema: z.object({ assetId: z.string(), style: z.enum(['minimal', 'clipper']).optional() }), execute: async (_ctx, input) => savedCheckpoint(input.assetId,t => {
      const asset = assets.find(a => a._id === input.assetId); const rawTranscript = asset?.analysis?.transcript;
      if (!rawTranscript || (!rawTranscript.words.length && !rawTranscript.segments.length)) throw new Error("Run Auto subtitles on this source first; no transcript is saved");
      const transcript = asset.analysis?.audioActivity ? refineTranscriptWithAudioActivity(rawTranscript, asset.analysis.audioActivity) : rawTranscript;
      const captions = t.clips.filter(clip => clip.assetId === input.assetId).flatMap(clip => captionClipsFromTranscript(clip, transcript, t.fps, () => crypto.randomUUID(), input.style ?? (lane === 'clip' ? 'clipper' : 'minimal')));
      if (!captions.length) throw new Error("Add a source clip that overlaps its transcript before adding subtitles");
      return captions.reduce((timeline, clip) => placeOnFreeLayer(timeline, clip), t);
    }) }),
    markMusicBeats: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.markMusicBeats, description: "Add orange markers in a specific audio clip without moving or cutting clips. Choose kind beats for musical pulse (default), downbeats for bar starts, accents for main/strong/audible hits useful for flashes or zooms, or dropCandidates for uncertain energy rises. Never substitute every beat for requested main hits. Analyze automatically if the current requested map is missing. Optional start/end are timeline seconds within that clip. Preserve existing markers and avoid duplicates. Drop candidates are possible drops to check by ear, not verified musical drops; inspect their evidence and explain uncertainty first unless the user explicitly requests candidate markers.", inputSchema: z.object({ clipId: z.string(), kind: z.enum(['beats', 'downbeats', 'accents', 'dropCandidates']).optional(), start: z.number().min(0).optional(), end: z.number().positive().optional() }), execute: async (_ctx, input) => {
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId);
      let asset=clip.assetId?await loadAsset(clip.assetId):undefined;
      if (clip.kind !== 'audio' || !asset) throw new Error('Choose the song’s audio clip.');
      const kind = input.kind ?? 'beats';
      if (asset.analysis?.beats?.engine !== BEAT_ANALYSIS_ENGINE || asset.analysis.beats[kind] === undefined) asset = await analyze(asset._id, 'beats');
      let markers!: ReturnType<typeof addBeatMarkers>;
      const result = await checkpoint(timeline => {
        markers = addBeatMarkers(timeline, input.clipId, asset!.analysis?.beats, { ...input, kind });
        return markers.timeline;
      });
      return { ...result, kind, added: markers.added, skipped: markers.skipped, confidence: markers.confidence, status: markers.status, message: markers.message };
    } }),
    analyzeMusic: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.analyzeMusic, description: "Read a song's structure from its measured signal, so you never guess where it gets good: tempo, every bar with its downbeat time, loudness (LUFS), low band (kick and bass, dBFS) and onsets per second; sections (low, mid, build, peak, drop, outro) split where the energy changes at a bar line, each with a confidence and the numbers behind it; the strongest moments ranked, each on a downbeat with its loudness jump in dB, low-band jump, onset density before and after, and the first sung line from a saved transcript; and the best windows for each target edit length, in whole bars, with what they open and end on. Times are SOURCE seconds of the song, and with clipId also timeline seconds. Measures the song on first use (beat tracking plus energy, saved with the asset like other analyses), then reads the saved result. Follow with startMusicAt to start the song on a moment.", inputSchema: z.object({ clipId: z.string().min(1).optional().describe('The song\'s audio clip on the timeline (or a video with linked audio); adds timeline times.'), assetId: z.string().min(1).optional().describe('A song in the project media that is not on the timeline yet.'), lengths: z.array(z.number().min(3).max(300)).min(1).max(4).optional().describe('Target edit lengths in timeline seconds for the recommended windows (default 15 and 30).') }).strict().refine(input => (input.clipId === undefined) !== (input.assetId === undefined), { message: 'Choose clipId or assetId.' }), execute: async (_ctx, input) => {
      const song = await readSong(input);
      const { structure, clip, asset } = song;
      const sourceEnd = clip ? sourceEndOf(clip) : 0;
      const onTimeline = (time: number) => clip ? { timeline: Math.round(timelineTimeAtSource(clip, time) * 1000) / 1000, inClip: time >= clip.sourceStart - 1e-3 && time < sourceEnd } : {};
      return {
        assetId: asset._id, ...(clip ? { clipId: clip.id, clipSource: { start: clip.sourceStart, end: Math.round(sourceEnd * 1000) / 1000 } } : {}),
        bpm: structure.bpm, beatsPerBar: structure.beatsPerBar, barSeconds: structure.barSeconds, phraseSeconds: { fourBars: Math.round(structure.barSeconds * 4 * 100) / 100, eightBars: Math.round(structure.barSeconds * 8 * 100) / 100 }, beatConfidence: structure.beatConfidence,
        loudness: { loudBarLufs: structure.loudLufs, quietBarLufs: structure.quietLufs, note: 'Section and moment dB are against loudBarLufs, the 90th percentile bar.' },
        sections: structure.sections.map(section => ({ ...section, ...(clip ? { timelineStart: onTimeline(section.start).timeline, timelineEnd: onTimeline(section.end).timeline } : {}) })),
        moments: structure.moments.map(moment => ({ ...moment, ...onTimeline(moment.time) })),
        windows: structure.windows.map(window => ({ ...window, ...(clip ? { timelineStart: onTimeline(window.start).timeline } : {}) })),
        bars: { columns: ['bar', 'start', 'lufs', 'low', 'onsetsPerSecond'], rows: structure.bars.map(bar => [bar.bar, bar.start, bar.lufs, bar.low, bar.onsetsPerSecond]) },
        ...(structure.measuredUntil < (asset.duration ?? 0) - 1 ? { measuredUntil: structure.measuredUntil } : {}),
        ...(song.words.length ? {} : { lyrics: 'No saved transcript for this song, so sung lines are not named. analyzeMedia mode transcribe adds them.' }),
        next: clip ? 'Start the song on a moment with startMusicAt (moment rank, or a window start as sourceTime, plus length). Then listen with getSound from 2 s before to 4 s after its timeline start: the onsets and the momentary loudness should rise at that second.' : 'Place the song with addMedia, then startMusicAt with its clipId.',
      };
    } }),
    startMusicAt: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.startMusicAt, description: "Start a song's audio clip at a chosen musical moment, exactly on a downbeat, without doing bar maths: moment is a rank from analyzeMusic (default 1, the strongest), or sourceTime is a SOURCE second (snapped to the nearest downbeat, e.g. a window start). length (seconds) is rounded to whole bars, whole 4-bar phrases when close, so the song ends on a bar line; without it the clip keeps its current length. at moves the clip's timeline start (default: it stays where it is). The song's existing fades, volume and ducking are kept.", inputSchema: z.object({ clipId: z.string().min(1), moment: z.number().int().min(1).max(5).optional(), sourceTime: z.number().min(0).optional(), length: z.number().min(1).max(3600).optional(), at: z.number().min(0).optional() }).strict(), execute: async (_ctx, input) => {
      if (input.moment !== undefined && input.sourceTime !== undefined) throw new Error('Choose moment or sourceTime, not both.');
      await editSession.wait();
      const target = find(editSession.timeline, input.clipId);
      if (target.kind !== 'audio' || !target.assetId) throw new Error('Choose the song\'s audio clip.');
      if (target.linkedClipId) throw new Error('This song plays with its video. Unlink them first (unlink), then start the audio at a moment.');
      if (target.speedRamp?.length) throw new Error('This song has a speed ramp; remove it before starting the song at a moment.');
      const rate = playbackRateOf(target);
      const { structure, clip, asset, map } = await readSong({ clipId: input.clipId, ...(input.length !== undefined ? { lengths: [input.length] } : {}) });
      if (!clip) throw new Error('Choose the song\'s audio clip.');
      const chosen = input.sourceTime === undefined ? structure.moments[(input.moment ?? 1) - 1] : undefined;
      if (input.sourceTime === undefined && !chosen) throw new Error(`analyzeMusic found ${structure.moments.length} moment${structure.moments.length === 1 ? '' : 's'}; choose one of those ranks or pass sourceTime.`);
      const start = chosen ? chosen.time : nearestDownbeat(map, input.sourceTime!);
      const bars = structure.bars, first = bars.findIndex(bar => Math.abs(bar.start - start) < 1e-3);
      const songEnd = asset.duration ?? start + clip.duration * rate;
      let end: number, count: number | undefined;
      if (input.length !== undefined) {
        count = barsForLength(input.length * rate, structure.barSeconds);
        end = first >= 0 && bars[first + count - 1] ? bars[first + count - 1].end : start + count * structure.barSeconds;
        if (end > songEnd + 1e-3) throw new Error(`From ${start} s the song has ${Math.round((songEnd - start) * 10) / 10} s left, less than ${count} bars. Pick an earlier moment or a shorter length.`);
      } else end = Math.min(songEnd, start + clip.duration * rate);
      const duration = (end - start) / rate;
      const result = await checkpoint(t => {
        // Move first: the new length may only fit at the requested place.
        const moved = input.at !== undefined ? moveClipTo(t, clip.id, input.at) : t;
        return trimClip(moved, clip.id, duration, start);
      });
      const placed = find(editSession.timeline, clip.id);
      return { ...result, clipId: clip.id, sourceStart: start, sourceEnd: Math.round(end * 1000) / 1000, timelineStart: placed.start, timelineEnd: Math.round((placed.start + placed.duration) * 1000) / 1000,
        startsOn: chosen ? `moment ${chosen.rank} (bar ${chosen.bar}): ${chosen.why}` : `the downbeat at ${start} s${Math.abs(start - input.sourceTime!) > 1e-3 ? ` (nearest to ${input.sourceTime} s)` : ''}`,
        endsOn: count === undefined ? 'the clip keeps its length; it may not end on a bar line' : `${count} bars later${count % 4 === 0 ? `, the end of its ${count}-bar phrase` : ''}`,
        check: { tool: 'getSound', arguments: { start: Math.max(0, placed.start - 2), end: placed.start + 4 } } };
    } }),
    setAudioReactive: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setAudioReactive, description: "Make clips react to music: a level curve from one song's detected beats (pulse on each hit, instant attack, `decay` release) or its loudness (energy) drives up to 4 targets per clip. CSS targets work on footage, images, text and solids: scale (amount -0.5..0.5, e.g. 0.06 = 6% bump), shake (0..0.1 of the frame, e.g. 0.01), rotate (-20..20 degrees). Effect controls work on video/image: any keyframeable control such as colorGrade.exposure (0.3), glitch.intensity (0.6), zoomBlur.amount (0.4), lightLeak.amount, softBlur.amount, lensDistortion.amount; the amount is added at full level and is 0 in silence. Modes: beats, downbeats (bar starts), accents (strong hits), energy (follows loudness; sensitivity 0..1). Subtle defaults read best: scale 0.04-0.08 on beats, glitch on accents. Covers each clip's own time span (up to 4 minutes). clear:true removes it. Rendered identically in preview and export.", inputSchema: z.object({ clipIds: clipIdsInput, musicClipId: z.string().min(1).optional().describe('The audio clip whose sound drives the reaction; omit when clear'), mode: z.enum(['beats', 'downbeats', 'accents', 'energy']).optional(), targets: z.array(z.object({ property: z.string().min(1).max(60).describe(`${CSS_REACTIVE_TARGETS.join(', ')} or group.control`), amount: z.number() }).strict()).min(1).max(4).optional(), sensitivity: z.number().min(0).max(1).optional(), decay: z.number().min(.03).max(1.5).optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => {
      if (input.clear) return checkpoint(t => { let next = t; for (const id of input.clipIds) next = patchClip(next, find(next, id).id, { audioReactive: undefined }); return next; });
      if (!input.musicClipId || !input.targets) throw new Error('Give musicClipId and targets, or clear:true.');
      for (const target of input.targets) { const range = reactiveAmountRange(target.property); if (!range) throw new Error(`${target.property} cannot react to audio. Use ${CSS_REACTIVE_TARGETS.join(', ')} or an effect control such as glitch.intensity.`); if (target.amount < range[0] || target.amount > range[1]) throw new Error(`${target.property} amount must be between ${range[0]} and ${range[1]}.`); }
      await editSession.wait();
      let music = find(editSession.timeline, input.musicClipId);
      // A video's sound lives on its linked audio clip.
      if (music.kind === 'video' && music.linkedClipId) music = find(editSession.timeline, music.linkedClipId);
      if (music.kind !== 'audio' || !music.assetId) throw new Error('Choose the song’s audio clip as musicClipId.');
      const mode = input.mode ?? 'beats', decay = input.decay ?? (mode === 'energy' ? .12 : .22);
      let asset = await loadAsset(music.assetId);
      let sampleAt: ((time: number) => number | undefined) | undefined, hits: { time: number; strength: number }[] = [];
      const musicEnd = music.start + music.duration;
      if (mode === 'energy') {
        if (!asset.waveform) throw new Error('This audio’s waveform is still being measured. Try again shortly.');
        const peaks = decodeLevels(asset.waveform.peaks), rate = asset.waveform.samplesPerSecond;
        sampleAt = time => { if (time < music.start || time >= musicEnd) return undefined; const index = Math.floor(sourceTimeAt(music, time) * rate); return index >= 0 && index < peaks.length ? peaks[index] / 255 : undefined; };
      } else {
        const kind = mode === 'downbeats' ? 'downbeats' : mode === 'accents' ? 'accents' : 'beats';
        if (asset.analysis?.beats?.engine !== BEAT_ANALYSIS_ENGINE || asset.analysis.beats[kind] === undefined) asset = await analyze(asset._id, 'beats');
        const map = asset.analysis?.beats;
        const raw = kind === 'accents' ? map?.accents ?? [] : (kind === 'downbeats' ? map?.downbeats ?? [] : map?.beats ?? []).map(time => ({ time, strength: kind === 'beats' && map?.downbeats?.some(down => Math.abs(down - time) < .03) ? 1 : kind === 'beats' ? .75 : 1 }));
        hits = raw.map(hit => ({ time: timelineTimeAtSource(music, hit.time), strength: Math.min(1, Math.max(.2, hit.strength)) })).filter(hit => hit.time >= music.start - 1e-6 && hit.time < musicEnd);
        if (!hits.length) throw new Error(`No ${kind} were detected in this song's clip.`);
      }
      const reacted: { clipId: string; peaks: number }[] = [];
      const saved = await checkpoint(t => {
        let next = t;
        for (const id of input.clipIds) {
          const clip = find(next, id), start = clip.start, end = clip.start + clip.duration;
          if (end - start > MAX_REACTIVE_SAMPLES / REACTIVE_RATE) throw new Error(`Clip ${id} is longer than ${MAX_REACTIVE_SAMPLES / REACTIVE_RATE / 60} minutes. Split it first.`);
          const values = sampleAt ? energyLevels(sampleAt, start, end, input.sensitivity ?? .6, decay) : pulseLevels(hits, start, end, decay);
          reacted.push({ clipId: id, peaks: hits.filter(hit => hit.time >= start && hit.time < end).length });
          next = patchClip(next, clip.id, { audioReactive: { rate: REACTIVE_RATE, start, levels: encodeLevels(values), targets: input.targets! } });
        }
        return next;
      });
      return { ...saved, mode, reacted: mode === 'energy' ? reacted.map(item => item.clipId) : reacted };
    } }),
    addMarker:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addMarker,description:"Add an explicitly requested ordinary timeline cue at user-provided seconds, snapped to project frames, with an optional user-provided label. Preserve clips and existing cues; a frame that already has a cue adds no duplicate, while a cue may share a film section marker's frame. This does not analyze audio or claim a measured beat/hit. For measured musical markers use markMusicBeats instead.",inputSchema:z.object({time:z.number().min(0),label:z.string().min(1).max(120).optional()}),execute:async(_ctx,{time,label})=>checkpoint(t=>addTimelineMarker(t,time,crypto.randomUUID(),label??null))}),
    moveMarker:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.moveMarker,description:"Move one existing ordinary or measured cue by exact markerId from inspectTimeline to explicitly requested timeline seconds, snapped to frames. Preserve its ID/label and every other cue/clip. This manual move does not analyze music or assert a new measured beat. A film's section markers follow its section() calls: change a section's start with patchScene instead of moving its marker.",inputSchema:z.object({markerId:z.string().min(1).max(100),time:z.number().min(0)}),execute:async(_ctx,{markerId,time})=>checkpoint(t=>{if(!t.markers?.some(marker=>marker.id===markerId))throw new Error('Choose an existing timeline marker ID.');return moveTimelineMarker(t,markerId,time)})}),
    removeMarker: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.removeMarker, description: "Remove one orange timeline marker using its exact marker ID from inspectTimeline. Leaves all clips and other markers unchanged; works even when the marker has no label. An already absent ID makes no change. Returns actual removedMarkerIds and removed count.", inputSchema: z.object({ markerId: z.string().min(1).max(100) }), execute: async (_ctx, input) => markerCheckpoint(t => removeTimelineMarker(t, input.markerId)) }),
    removeMarkers: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.removeMarkers, description: "Remove orange timeline markers without touching clips. Choose scope all only when asked to remove or clear all markers; choose selected with exact markerIds from inspectTimeline for a specific set. Labels are optional, so use IDs. Returns actual removedMarkerIds and removed count, including zero when no markers matched.", inputSchema: z.object({ scope: z.enum(['all', 'selected']), markerIds: z.array(z.string().min(1).max(100)).min(1).max(1000).optional() }).refine(input => input.scope === 'selected' ? input.markerIds !== undefined : input.markerIds === undefined, { message: 'Use selected with markerIds, or all without markerIds.' }), execute: async (_ctx, input) => markerCheckpoint(t => removeTimelineMarkers(t, input.scope === 'all' ? undefined : input.markerIds)) }),
    matchMusic: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.matchMusic, description: "Give a recreation music that matches the reference's, never its own audio. Measures the reference video's tempo, beat grid and energy curve, then picks the closest Mixkit library track (open license, measured BPM, genre and energy) by tempo and feel, and places it so its downbeats land on the reference's downbeats (or on the main moments you pass), starting at the stretch of the track whose energy follows the reference's, nudged up to 8% in speed (pitch kept) to lock the tempo. The track is copied into the project with its beat map, so alignCutsToBeat with the returned musicAssetId works right away; the clip name carries the credit. When no track is within reach, it renders a synthesized bed at the reference's tempo instead.", inputSchema: z.object({ referenceAssetId: z.string().describe('The reference video (or its audio) from getProject.'), moments: z.array(z.number().min(0)).max(40).optional().describe("The film's main moments in reference SOURCE seconds (the big hits of the motion log). Default: the reference's own downbeats."), at: z.number().min(0).optional().describe('Timeline seconds where the film starts (default 0).'), referenceStart: z.number().min(0).optional().describe('The reference second the film starts at, when it recreates an excerpt (default 0: the film starts where the reference does).'), duration: z.number().positive().max(MUSIC_BED_LIMITS.duration).optional().describe('Music length in seconds; default: to the end of the visuals on the timeline.'), style: z.string().max(80).optional().describe('Genre or mood words heard or wanted (house, lo-fi, funk, uplifting, chill...), matched against track genres and tags.'), trackId: z.string().optional().describe('A library track id (mixkit-…) to use instead of the best match, e.g. one of the alternatives from an earlier call.'), synth: z.boolean().optional().describe('Render a synthesized bed instead of a library track.'), feel: z.enum(['calm', 'warm', 'upbeat', 'driving']).optional().describe("Override the measured feel."), gain: z.number().min(0).max(1.2).optional().describe('Clip volume (default 0.45, under the motion sounds).') }), execute: async (_ctx, input) => {
      let reference = await loadAsset(input.referenceAssetId);
      if (reference.kind !== 'video' && reference.kind !== 'audio') throw new Error('Choose the reference video or its audio.');
      const source = reference.kind === 'video' && reference.audioAssetId ? await loadAsset(reference.audioAssetId) : reference;
      reference = source.analysis?.beats?.engine === BEAT_ANALYSIS_ENGINE ? source : await analyze(source._id, 'beats');
      const beats = reference.analysis?.beats;
      if (!beats || beats.beats.length < 8) throw new Error('The reference has too few clear beats to match its tempo. Pick a track by ear (trackId) or a synthesized bed with a feel.');
      const grid = beatGrid(beats), at = input.at ?? 0;
      await editSession.wait();
      const visualEnd = Math.max(0, ...editSession.timeline.clips.filter(clip => clip.kind !== 'audio' && clip.kind !== 'effect').map(clip => clip.start + clip.duration));
      const duration = Math.min(MUSIC_BED_LIMITS.duration, input.duration ?? (visualEnd > at ? visualEnd - at : (reference.duration ?? 30)));
      // The first downbeat to land on, in film seconds: on the main moments, or the reference's own, shifted when the film is an excerpt.
      const from = input.referenceStart ?? 0, referencePhase = input.moments?.length ? phaseForMoments(input.moments, grid.period) : grid.phase;
      const phase = (((referencePhase - from) % grid.bar) + grid.bar) % grid.bar;
      const whole = reference.waveform ? energyCurve(reference.waveform, reference.duration ?? duration, 1) : undefined;
      const curve = whole && { ...whole, values: whole.values.slice(Math.floor(from)) };
      const feel = input.feel ?? feelOf(grid.bpm, curve?.values ?? []);
      const picks = input.synth ? [] : rankStockMusic({ bpm: grid.bpm, energy: curve?.values ?? [], level: curve?.level, style: input.style, trackId: input.trackId });
      if (input.trackId && !picks.length) throw new Error(`No library track ${input.trackId}.`);
      const pick = picks[0] && (input.trackId || picks[0].fits) ? picks[0] : undefined;
      const gain = input.gain ?? .45, clipId = crypto.randomUUID();
      let asset: (typeof assets)[number], placement: { sourceStart: number; rate: number }, credit: string | undefined;
      if (pick) {
        const track = pick.track;
        placement = placeStockMusic(track, pick.rate, phase, duration, curve?.values ?? []);
        asset = assets.find(item => item.fileName === stockMusicFileName(track)) ?? await (async () => {
          const response = await fetch(track.url, { headers: { referer: MIXKIT_REFERER, 'user-agent': 'Mozilla/5.0 (Revline)' }, signal: AbortSignal.any([abortSignal, AbortSignal.timeout(60_000)]) });
          if (!response.ok) throw new Error(`Mixkit did not return ${track.title} (${response.status}). Try another trackId or synth:true.`);
          const bytes = new Uint8Array(await response.arrayBuffer()), key = newProjectMediaKey(run.ownerId, run.projectId);
          const size = await putMediaObject(key, bytes, 'audio/mpeg');
          try {
            const saved = await ctx.runMutation(internal.assistant.saveGeneratedSound, { ...run, r2Key: key, fileName: stockMusicFileName(track), contentType: 'audio/mpeg', size, duration: track.duration, waveform: track.waveform, beats: { beats: track.beats, bpm: track.bpm, confidence: track.confidence, engine: BEAT_ANALYSIS_ENGINE, downbeats: track.downbeats, accents: track.accents, dropCandidates: [] } });
            assets.push(saved);
            return saved;
          } catch (error) { await storageControl({ action: 'delete', key }).catch(() => {}); throw error; }
        })();
        credit = `"${track.title}" by ${track.artist}, Mixkit (${MIXKIT_LICENSE.name})`;
      } else {
        // Nothing in the library is close enough: a bed rendered at the reference's tempo, downbeats on its grid.
        const firstBar = Math.floor(-phase / grid.bar);
        const perBar = reference.waveform ? energyCurve(reference.waveform, Math.max(reference.duration ?? duration, duration), grid.bar, from + phase + firstBar * grid.bar).values : undefined;
        const bed = renderMusicBed({ duration, bpm: grid.bpm, feel, phase, energy: perBar });
        const key = newProjectMediaKey(run.ownerId, run.projectId), size = await putMediaObject(key, encodeWav(bed.samples), 'audio/wav');
        try { asset = await ctx.runMutation(internal.assistant.saveGeneratedSound, { ...run, r2Key: key, fileName: `Music bed ${Math.round(bed.bpm)} BPM ${feel}.wav`, size, duration: bed.samples[0].length / SR, waveform: soundWaveform(bed.samples), beats: { beats: bed.beats, bpm: bed.bpm, confidence: 1, engine: BEAT_ANALYSIS_ENGINE, downbeats: bed.downbeats, accents: [], dropCandidates: [], energy: bedEnergy(bed.samples) } }); }
        catch (error) { await storageControl({ action: 'delete', key }).catch(() => {}); throw error; }
        assets.push(asset);
        placement = { sourceStart: 0, rate: 1 };
      }
      const result = await checkpoint(t => {
        const start = Math.round(at * t.fps) / t.fps, length = Math.min(duration, (asset.duration! - placement.sourceStart) / placement.rate), end = start + length;
        const busy = new Set(t.clips.filter(clip => clip.kind === 'audio' && clip.start < end && start < clip.start + clip.duration).map(trackOf));
        let track = 1; while (busy.has(track) && track < maxTrackCount('audio')) track++;
        let next = addMediaClip(t, { _id: asset._id, kind: 'audio', duration: asset.duration! }, clipId, start, track);
        next = patchClip(next, clipId, { sourceStart: placement.sourceStart, duration: length * placement.rate, volume: gain });
        if (placement.rate !== 1) next = setClipPlaybackRate(next, clipId, placement.rate);
        return configureAudio(next, clipId, { role: 'music', fadeIn: placement.sourceStart > 0 ? .25 : 0, fadeOut: Math.min(1.5, length / 6) });
      });
      const moments = input.moments ?? beats.downbeats?.slice(0, 8) ?? [];
      return { ...result, clipId, musicAssetId: asset._id, ...(pick ? { track: { id: pick.track.id, title: pick.track.title, artist: pick.track.artist, genre: pick.track.genre, bpm: pick.track.bpm, score: pick.score }, credit, sourceStart: placement.sourceStart, playbackRate: placement.rate } : { synthesized: true, feel }), referenceBpm: grid.bpm, referenceFeel: feel, alternatives: picks.slice(pick ? 1 : 0, (pick ? 1 : 0) + 3).map(item => ({ id: item.track.id, title: item.track.title, artist: item.track.artist, genre: item.track.genre, bpm: item.track.bpm, score: item.score })), momentFit: momentFit(moments.map(time => time - from).filter(time => time >= 0), grid.period, phase).map(item => ({ ...item, time: Math.round((at + item.time) * 1000) / 1000 })), note: `${pick ? 'Library track, chosen by measured tempo and energy; not listened to.' : 'Synthesized at the reference tempo because no library track was close; not listened to.'} Downbeats sit on the reference's (momentFit shows each moment's distance). A film built with addFilm is one clip whose sections are markers: its moments already sit on these downbeats, so do not run alignCutsToBeat on it (it can only move the clip's end and would trim the film). For separate clips, alignCutsToBeat with this musicAssetId snaps their cuts. Keep generated effects 0.2 to 0.3 above it. Credit the track when sharing.` };
    } }),
    alignCutsToBeat: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.alignCutsToBeat, description: "Snap the cuts between consecutive clips on V1 (footage, images and motion scenes), and the end of the last one, to the nearest beats in this music source's current dedicated beat-tracking map, keeping their order. Use it whenever the user wants cuts, scene changes or an ending on the beat, even for a single clip; never resize clips by hand to reach a beat. Run analyzeMedia mode beats first if the map is missing or came from the legacy onset detector. Footage must be long enough for its adjusted cut. A film is one clip: never run this on it; move its section() start times to the beat in code with patchScene instead.", inputSchema: z.object({ musicAssetId: z.string() }), execute: async (_ctx, input) => savedCheckpoint(input.musicAssetId,t => {
      const music = assets.find(a => a._id === input.musicAssetId); const map = music?.analysis?.beats; const beats = map?.beats;
      if (map?.engine !== BEAT_ANALYSIS_ENGINE || !beats?.length) throw new Error("Run Find beats on this source first; no current dedicated beat map is saved");
      return alignCutsToBeats(t, assets.map(asset => ({ ...asset, url: null })), input.musicAssetId, beats);
    }) }),
    useStrongestMoment: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.useStrongestMoment, description: "Use the highest-scored scene from a saved footage understanding result. Replace this source's first video shot, or append a shot if it has not been used. When scenes are unavailable, returns a hint to choose an evidenced range with readFrames and transcript tools instead. Never guess a source moment.", inputSchema: z.object({ assetId: z.string() }), execute: async (_ctx, input) => {
      const asset = await loadAsset(input.assetId), scenes = asset.analysis?.understanding?.scenes;
      if (asset.kind !== "video") throw new Error("Choose a video source");
      if (!scenes?.length) return { ...understandingUnavailable(input.assetId), applied: false };
      return checkpoint(t => {
        const scene = scenes.reduce((strongest, current) => current.score > strongest.score ? current : strongest);
        const range = shotAlignedRange(scene, asset.analysis?.shots);
        const existing = t.clips.find(clip => clip.kind === "video" && clip.assetId === input.assetId);
        const start = existing?.start ?? timelineDuration(t);
        const duration = Math.min(range.end - range.start, (asset.duration ?? range.end) - range.start) / (existing ? playbackRateOf(existing) : 1);
        if (duration < 1 / t.fps) throw new Error("The strongest scene is shorter than one frame");
        const id = existing?.id ?? crypto.randomUUID();
        const next = existing ? t : addMediaClip(t, { ...asset, duration }, id, start);
        const shot = find(next, id);
        return placeOnFreeLayer(next, { ...shot, sourceStart: range.start, duration, focus: asset.analysis?.focus ? focusForClip(asset.analysis.focus, { ...shot, sourceStart: range.start, duration }) : undefined });
      });
    } }),
    inspectAssetAnalysis: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.inspectAssetAnalysis, description: "For transcript-first clips pass transcriptOnly:true to return only transcript evidence, with start/end or windows for boundary words. Read this media's saved transcript, scene descriptions and measured shot boundaries. The default transcript includes sentence segments and a word-timing read hint. Supply start/end SOURCE seconds for the relevant sentence, preferably windows up to 30 seconds, to receive exact overlapping words with text/start/end. To read several sentences, pass them together as windows (up to eight) in ONE call rather than calling this tool once per window. Measured source audio quiet intervals, dense subject tracking and beat samples are summarized by default; ranged reads return their exact samples. Audio energy is not a visual observation or proof of silence. Visual descriptions remain intact. Scene understanding can be absent even when media is ready. Use saved transcript evidence and readFrames for missing visual context; do not wait for or retry an overview. Never invent results. Saved speaker analysis returns framing intervals (SOURCE start/end, shot, method, confidence, face, local faceId) and speakers.turns (speaker ID, face rectangle or null, matching confidence). Source speaker IDs come from the diarized source transcript; window speaker IDs and faceIds are local to their analysis window.", inputSchema: z.object({ assetId: z.string(), start: z.number().min(0).optional(), end: z.number().positive().optional(), windows: z.array(z.object({ start: z.number().min(0), end: z.number().positive() })).min(1).max(8).optional(), transcriptOnly: z.boolean().optional() }).refine(input => (input.start === undefined && input.end === undefined) || (input.start !== undefined && input.end !== undefined && input.end > input.start), { message: 'Provide a valid start/end SOURCE range together.' }), execute: async (_ctx, input) => {
      let asset = await loadAsset(input.assetId);
      // Transcripts made before windowed transcription merged repeated takes
      // and dropped speech. Refresh one before the model plans cuts from it;
      // a failed refresh is not retried by every later read in this run.
      if (asset.analysis?.transcript && !currentTranscript(asset.analysis.transcript) && !transcriptRefreshFailures.has(asset._id)) {
        try { asset = await analyze(asset._id, 'transcribe'); }
        catch (error) { transcriptRefreshFailures.set(asset._id, error instanceof Error ? error.message : 'unknown error'); }
      }
      const transcriptNote = asset.analysis?.transcript && !currentTranscript(asset.analysis.transcript) ? `This transcript predates current transcription and may merge repeated takes or miss speech${transcriptRefreshFailures.has(asset._id) ? `; refreshing it failed (${transcriptRefreshFailures.get(asset._id)})` : ''}. Treat lines missing from it as unverified, not absent, and ask the user rather than watching the footage to find them.` : undefined;
      if (!asset.analysis) return { assetId: asset._id, unavailable: true, understandingNote: OPTIONAL_UNDERSTANDING_NOTE };
      const evidence = input.transcriptOnly ? { transcript: asset.analysis.transcript } : asset.analysis;
      const read = input.windows ? modelAssetAnalysisWindows(evidence, input.windows) : modelAssetAnalysis(evidence, input.start !== undefined && input.end !== undefined ? { start: input.start, end: input.end } : undefined);
      return { assetId: asset._id, ...read, ...(transcriptNote ? { transcriptNote } : {}) };
    } }),
    closeGaps: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.closeGaps, description: "Join footage after cuts: close every gap between video/image clips on each visual layer in ONE saved change, moving later clips earlier with their linked audio. Retained source ranges, speed and styling are unchanged. Optional clipIds (two or more) limits it to those clips. Use this instead of moving clips one at a time. Captions and overlays on other tracks do not move with it: ripple them with moveClips.", inputSchema: z.object({ clipIds: clipIdsInput.optional() }), execute: async (_ctx, input) => checkpoint(t => closeFootageGaps(t, input.clipIds ?? [])) }),
    retainSourceRanges: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.retainSourceRanges, description: "Keep ordered SOURCE-time ranges from one existing video/audio clip and compact them at that clip's timeline start in one change. For any speech cut use tightenSilence:true: the source's measured speech cleanup then runs automatically inside the kept ranges (pauses, breaths and filler words removed between words) and every edge snaps to the measured sound of its words, to the millisecond; report its speechCleanup summary to the user. keepPauses:true keeps natural pauses and fillers (only edges are tightened) when the user asks for that. Without a cleanup map, outer quiet edges are tightened with 80ms padding. Omit tightenSilence for exact user-requested timestamp cuts. Every requested range must fit the current retained source; never restore removed footage. Preserve speed, styling, motion/fade phase and linked audio. Without tightenSilence edges round outward to project frames unless exactEdges:true. Other clips/tracks/markers keep their positions; no global ripple. Refuses transition-connected sources. Inspect actual retained ranges before adding subtitles. Missing source audio energy is backfilled locally without transcribing again.", inputSchema: z.object({ clipId: z.string().min(1).max(100), ranges: z.array(z.object({ start: z.number().min(0), end: z.number().positive() }).strict()).min(1).max(100), tightenSilence: z.boolean().optional(), keepPauses: z.boolean().optional(), exactEdges: z.boolean().optional() }), execute: async (_ctx, input) => {
      let evidence: (typeof assets)[number] | undefined;
      if (input.tightenSilence) {
        const speech = await speechEvidence(input.clipId);
        if (speech.cleanup) {
          // Validate the request as asked before measured adjustment.
          retainSourceRanges(editSession.timeline, input.clipId, input.ranges, undefined, true);
          return applySpeechCut(input.clipId, speech, input.ranges, input.keepPauses ? new Set() : new Set(['pause', 'breath', 'filler']), .6);
        }
        evidence = speech.evidence;
      }
      let ranges: RetainedRangeSummary[] = [];
      let tightened = false;
      const result = await checkpoint(t => {
        // Validate the original request before any measured adjustment.
        let retained = retainSourceRanges(t, input.clipId, input.ranges, undefined, input.exactEdges);
        if (evidence?.analysis?.transcript && evidence.analysis.audioActivity) {
          const clip = find(t, input.clipId), pair = t.clips.find(member => member.id === clip.linkedClipId && member.assetId === evidence._id);
          const offset = clip.assetId === evidence._id ? 0 : pair ? pair.sourceStart - clip.sourceStart : undefined;
          if (offset === undefined) throw new Error('The audio evidence no longer matches this linked source.');
          const refined = input.ranges.map(range => {
            const measured = refineAudioRangeEdges({ start: range.start + offset, end: range.end + offset }, evidence!.analysis!.transcript!, evidence!.analysis!.audioActivity!);
            const next = { start: Math.max(range.start, measured.start - offset), end: Math.min(range.end, measured.end - offset) };
            return (next.end - next.start) / playbackRateOf(clip) >= 1 / t.fps - 1e-7 ? next : range;
          });
          tightened = refined.some((range, index) => range.start !== input.ranges[index].start || range.end !== input.ranges[index].end);
          if (tightened) retained = retainSourceRanges(t, input.clipId, refined, undefined, input.exactEdges);
        }
        ranges = retained.ranges; return retained.timeline;
      });
      return { ...result, retainedRanges: ranges, ...(evidence ? { silenceRefinement: { status: tightened ? 'applied' : evidence.analysis?.audioActivity?.reliable ? 'unchanged' : 'unreliable', evidenceAssetId: evidence._id, paddingSeconds: AUDIO_QUIET_EDGE_PAD } } : {}) };
    } }),
    cleanSpeech: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.cleanSpeech, description: "Remove filler words, breaths, pauses and abandoned retakes from one existing video/audio clip in ONE change, using the source's measured speech cleanup map. Each cut sits between words, never inside one; a retake keeps only its final attempt; every edge snaps to measured word sound, to the millisecond. Cuts below minConfidence (default 0.6) are kept; kinds limits what is removed (default all). preview:true returns the proposed cuts without editing. To assemble chosen takes prefer retainSourceRanges with tightenSilence:true, which applies the same cleanup inside the kept ranges; keep here does the same. Kept pieces compact at the clip's timeline start with linked audio, speed and styling preserved; other clips keep their positions, so close gaps afterwards when needed. Use for 'remove ums', 'cut the pauses', 'clean up the retakes' on a clip as a whole; report its speechCleanup summary.", inputSchema: z.object({ clipId: z.string().min(1).max(100), minConfidence: z.number().min(0).max(1).optional(), kinds: z.array(z.enum(['pause', 'breath', 'filler', 'restart'])).min(1).max(4).optional(), preview: z.boolean().optional(), keep: z.array(z.object({ start: z.number().min(0), end: z.number().positive() }).strict()).min(1).max(100).optional() }), execute: async (_ctx, input) => {
      if (input.keep?.some((range, index) => range.end <= range.start || (index > 0 && range.start < input.keep![index - 1].end))) throw new Error('keep ranges must be ordered and non-overlapping.');
      const speech = await speechEvidence(input.clipId);
      if (!speech.cleanup) throw new Error('Speech cleanup measurements are unavailable for this source. The media processor has not measured it yet; trim with retainSourceRanges instead.');
      const kinds = new Set<string>(input.kinds ?? (input.keep ? ['pause', 'breath', 'filler'] : ['pause', 'breath', 'filler', 'restart']));
      const chosen = input.keep ?? [{ start: speech.clip.sourceStart, end: speech.sourceEnd }];
      return applySpeechCut(input.clipId, speech, chosen, kinds, input.minConfidence ?? .6, input.preview);
    } }),
    setSplitEdits: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setSplitEdits, description: "Make J and L cuts at existing video cuts in ONE change. Each edit names the video clip BEFORE the cut. L: the outgoing sound carries over while the picture changes early (reaction or B-roll lands under the end of a line). J: the next line's sound starts while the previous picture is still showing, then the picture follows. seconds is how far the picture edit moves (subtle: 0.1 to 0.2 is usually enough; at most 2). Sound, speech cleanup and caption timing stay exactly where they are; only the picture edit point moves, using the source footage beside each piece, and those video clips are unlinked from their sound. Use for 'add J/L cuts', 'smoother cuts', 'let the audio lead'. Inspect the timeline first for the clip IDs.", inputSchema: z.object({ edits: z.array(z.object({ clipId: z.string().min(1).max(100), kind: z.enum(['J', 'L']), seconds: z.number().positive().max(MAX_SPLIT_EDIT_SECONDS) }).strict()).min(1).max(100) }), execute: async (_ctx, input) => checkpoint(t => input.edits.reduce((timeline, edit) => applySplitEdit(timeline, edit.clipId, edit.kind, edit.seconds, assetId => assets.find(asset => asset._id === assetId)?.duration), t)) }),
    split: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.split, description: "Split an existing clip at a timeline time in seconds. Source edits remain staged until the request completes. For a speech cut with several retained source ranges, prefer retainSourceRanges instead of a split/trim/delete chain.", inputSchema: z.object({ clipId: z.string(), time: z.number().min(0) }), execute: async (_ctx, input) => checkpoint(t => splitClip(t, input.clipId, input.time, crypto.randomUUID())) }),
    trim: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.trim, description: "Change duration and optional SOURCE trim start, in seconds. Use clipId/duration/sourceStart for one clip, OR edits:[{clipId,duration,sourceStart?}] for several independently specified trims in ONE validated operation. Prefer edits when several trim ranges are already known. Never supply both forms; target each linked pair only once because its audio stays synchronized automatically. Media source edits remain staged until completion. Effect clips have no source trim: duration stretches their animation. A duration that would run into the next clip on the same layer is refused with the room available.", inputSchema: z.object({ clipId:z.string().min(1).optional(),duration:z.number().positive().optional(),sourceStart:z.number().min(0).optional(),edits:z.array(trimChangeInput).min(1).max(200).refine(edits=>new Set(edits.map(edit=>edit.clipId)).size===edits.length,{message:'Choose unique clip IDs.'}).optional() }).strict().refine(input=>input.edits!==undefined?input.clipId===undefined&&input.duration===undefined&&input.sourceStart===undefined:input.clipId!==undefined&&input.duration!==undefined,{message:'Specify one clipId/duration or an edits array.'}), execute: async (_ctx, input) => checkpoint(t => {
      const edits=input.edits??[{clipId:input.clipId!,duration:input.duration!,sourceStart:input.sourceStart}];
      const ids=new Set(edits.map(edit=>edit.clipId));
      for(const edit of edits){const clip=find(t,edit.clipId);if(clip.linkedClipId&&ids.has(clip.linkedClipId))throw new Error('Trim each linked pair once; its matching audio follows automatically.');}
      let next=t;
      for(const edit of edits){const clip=find(next,edit.clipId);next=trimClip(next,clip.id,edit.duration,edit.sourceStart);}
      return next;
    }) }),
    move: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.move, description: "Move a clip in seconds or within its own track group: effects use FX1–FX24, video/images/text/solid-color use V1–V24, and audio uses A1–A12. The clip kind determines the group; Legacy solid-color FX can be explicitly converted using convertSolidColorToVisual before moving onto V. Start snaps to project frames; an occupied layer bumps the clip to the next free layer, and linked audio moves with its video exactly as a manual drag. Save immediately.", inputSchema: z.object({ clipId: z.string(), start: z.number().min(0).optional(), track: z.number().int().min(1).max(24).optional() }), execute: async (_ctx, input) => checkpoint(t => { const clip = find(t, input.clipId); if (input.start === undefined && input.track === undefined) throw new Error("Specify a timeline start or a layer"); return moveClipTo(t, clip.id, input.start, input.track); }) }),
    delete: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.delete, description: "Stage removal of one clip with clipId, OR several exact clips together with clipIds in ONE operation. Prefer clipIds when all removal targets are already known; never supply both. Existing linked-pair deletion behavior is preserved: unlink first when keeping the original audio or video partner. Validate every target before changing the draft; publish only after the request completes successfully.", inputSchema: z.object({clipId:z.string().min(1).optional(),clipIds:clipIdsInput.optional()}).strict().refine(input=>(input.clipId!==undefined)!==(input.clipIds!==undefined),{message:'Choose clipId or clipIds, never both.'}), execute: async (_ctx, input) => checkpoint(t => {const ids=input.clipIds??[input.clipId!];for(const id of ids)find(t,id);let next=t;for(const id of ids)if(next.clips.some(clip=>clip.id===id))next=deleteClip(next,id);return next;}) }),
    addCaption: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addCaption, description: "Add a timed caption with explicit text, styling and normalized position; save immediately. Defaults to minimal readable static subtitles with NO background. Add a box or animation only when requested; explicit background styling is preserved.", inputSchema: textInput, execute: async (_ctx, {textStyle,...input}) => checkpoint(t => placeOnFreeLayer(t, { id: crypto.randomUUID(), kind: "caption", sourceStart: 0, ...DEFAULT_CAPTION_STYLE, ...input, ...(textStyle?{textStyle:{...DEFAULT_CAPTION_STYLE.textStyle,...textStyle}}:{}) })) }),
    addGraphic: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addGraphic, description: "Add a text motion graphic with explicit text, styling and normalized position; save immediately.", inputSchema: textInput, execute: async (_ctx, {textStyle,...input}) => checkpoint(t => placeOnFreeLayer(t, { id: crypto.randomUUID(), kind: "graphic", sourceStart: 0, fontSize: 92, color: "#F4F4F0", background: "transparent", x: 0.5, y: 0.5, animation: "none", ...input, ...(textStyle?{textStyle:{...resolvedTextAppearance({kind:"graphic"}),...textStyle}}:{}) })) }),
    remember: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.remember, description: "Save to the user's memory so future edits, in any project, follow it without being told again. kind preference: one lasting rule ('Prefers captions in yellow, top third.', 'Never adds sound effects.', 'Brand color #7C3AED.'); save when the user says always/never/I prefer/my brand, or corrects the same thing twice. kind style: an edit the user liked ('perfect', 'love this', 'keep this look') or keeps asking for; give it a short name ('Podcast captions', 'Teal travel grade'), a one-line summary, and the recipe: the exact tools and settings that recreate it (read them with inspectClip first: font, size, colors, position, text look/animation, effects and their values, LUT and amount, curves, speed, timing habits like 'caption every 3 to 5 words'), written as compact JSON or terse lines, never whole clips or IDs. scope user (default) is for every project; scope project only for this one. Pass memoryId to update an existing memory. Never save one-off requests, secrets, or anything the user asks you not to remember. Tell the user in a few words what you remembered.", inputSchema: z.object({ kind: z.enum(['preference', 'style']).optional(), text: z.string().min(3).max(280), name: z.string().min(1).max(60).optional(), recipe: z.string().min(1).max(6000).optional(), scope: z.enum(['user', 'project']).optional(), memoryId: z.string().optional() }).strict(), execute: async (_ctx, input) => {
      const saved = await ctx.runMutation(internal.memories.remember, { ...run, kind: input.kind ?? 'preference', text: input.text, scope: input.scope ?? 'user', ...(input.name ? { name: input.name } : {}), ...(input.recipe ? { recipe: input.recipe } : {}), ...(input.memoryId ? { memoryId: input.memoryId } : {}) });
      return { remembered: saved };
    } }),
    recallMemory: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.recallMemory, description: "Load a remembered style's full recipe by memoryId before reapplying it: when the user says 'my usual', 'like last time', 'same captions as the podcast', or the request matches a saved style. Apply the recipe with the normal tools, adapting positions and timing to this footage, and say which style you used.", inputSchema: z.object({ memoryId: z.string().min(1) }).strict(), execute: async (_ctx, input) => ctx.runMutation(internal.memories.recall, { ...run, memoryId: input.memoryId }) }),
    forget: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.forget, description: "Delete a memory by memoryId when the user asks you to forget it or it no longer holds. Tell the user what you forgot.", inputSchema: z.object({ memoryId: z.string().min(1) }).strict(), execute: async (_ctx, input) => {
      await ctx.runMutation(internal.memories.forget, { ...run, memoryId: input.memoryId });
      return { forgotten: input.memoryId };
    } }),
    compareReference: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.compareReference, description: "Compare rendered pixels with a video or still image reference. For a still image, times are the timeline moments to compare with it (offset defaults 0). Give times for steady stretches, or start/end/fps (default 15) to compare every frame across a transition. Include padding before onset and after settle. Returns finished samples and a scoped receipt within the call budget; call nextAction to finish with the same fps, crop settings and offset. Use referenceCrop for a reference sub-panel and timelineCrop for its recreation (omit for full frame); regions are normalized on each displayed frame and scaled to match. crop remains shorthand for both, overridden by each explicit side. referenceCropKeyframes follows a moving panel with linearly interpolated crops in SOURCE seconds, holding endpoints outside its range. offset maps reference seconds to timeline seconds. The entire call uses one frozen timeline snapshot, so edits can continue while it runs. Returned revision identifies the saved source; rerun after edits. Scores are diagnostics, never a pass threshold: check each inventory item, first visible frame, count, exact content and motion. Fix big moves before polish, then compareMotion per section.", inputSchema: referenceComparisonInput, execute: async (_ctx, input) => {
      const stillReference = assets.find(asset => asset._id === input.assetId)?.kind === 'image';
      const deadline = Math.min(options.comparisonDeadline ?? Infinity, Date.now() + REFERENCE_COMPARISON_BUDGET_MS);
      await editSession.wait();
      const offset = input.offset ?? 0, requested = comparisonSamples(input), timelineId = boundRunTab(run.runId);
      if (input.times ? input.times.some(time => time + offset < 0) : input.start! + offset < 0) throw new Error('The offset places a reference sample before the timeline starts.');
      const scores: { time: number; difference: number }[] = [], images: { label: string; data: string; mimeType: string }[] = [];
      const {receipt: suppliedReceipt, cancel, ...work} = input;
      if(cancel&&!suppliedReceipt)throw new Error("Cancel requires the original comparison receipt.");
      const binding = JSON.stringify(work);
      type Progress = { fingerprint:string; snapshots: Id<'frameSnapshots'>[]; pending: {times:number[];snapshotId:Id<'frameSnapshots'>;readId?:Id<'referenceReads'>}[]; queued:number; completed:number; revision:number|null };
      const progress: Progress = suppliedReceipt ? JSON.parse(await ctx.runQuery(internal.comparisonContinuations.load,{ownerId:run.ownerId,projectId:run.projectId,timelineId:timelineId??'main',binding,receipt:suppliedReceipt})) : {fingerprint:await timelineHistoryKey(editSession.timeline),snapshots:[],pending:[],queued:0,completed:0,revision:null};
      const receipt = suppliedReceipt as Id<'comparisonContinuations'> | undefined ?? await ctx.runMutation(internal.comparisonContinuations.create,{ownerId:run.ownerId,projectId:run.projectId,timelineId:timelineId??'main',binding,state:JSON.stringify(progress)});
      if(cancel){await ctx.runMutation(internal.comparisonContinuations.expire,{id:receipt});return {status:'cancelled',samples:0,images:[]};}
      const {snapshots,pending} = progress;
      const save = () => ctx.runMutation(internal.comparisonContinuations.save,{id:receipt,state:JSON.stringify({...progress,queued,completed,revision})});
      const timelineCrop = input.timelineCrop ?? input.crop;
      // Leave room for scores and resume arguments below Convex's 16 MiB function return limit.
      const imageBudget = 8 * 1024 * 1024;
      let revision: number | null = progress.revision, queued = progress.queued, completed = progress.completed, imageBytes = 0;
      const queueBatch = async () => {
        if (queued >= requested.count || Date.now() >= deadline) return;
        if (abortSignal.aborted) throw new Error('Stopped.');
        const times = requested.batch(queued);
        const snapshotId = await ctx.runMutation(internal.mcp.requestFrames, { ownerId: run.ownerId, projectId: run.projectId, recreation: recreationRender(), ...(editSession.staged ? { runId: run.runId } : {}), ...(timelineId ? { timelineId } : {}), ...(snapshots[0] ? { sourceSnapshotId: snapshots[0] } : {}), comparison: timelineCrop ? { crop: timelineCrop } : {}, times: times.map(time => time + offset) });
        snapshots.push(snapshotId);
        pending.push({ times, snapshotId });
        queued += times.length;
        await save();
      };
      try {
        // Two render batches in flight match the local worker's default slots. The first freezes the source;
        // every later batch copies it. Score in order so continueFrom never skips an unfinished sample.
        if (!pending.length) await queueBatch();
        while (pending.length && Date.now() < deadline) {
          const batch = pending[0];
          const { times, snapshotId } = batch;
          let rendered = false;
          while (Date.now() < deadline) {
            if (abortSignal.aborted) throw new Error('Stopped.');
            const state = await ctx.runQuery(internal.mcp.frames, { ownerId: run.ownerId, snapshotId });
            revision = state.revision;
            if (state.status === 'failed') throw new Error(`Your timeline could not be rendered for the comparison: ${state.error ?? 'unknown error'}`);
            if (state.status === 'completed') { rendered = true; break; }
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1500, deadline - Date.now()))));
          }
          if (!rendered) break;
          const result = await runCompare(ctx, run.ownerId, run.projectId, input.assetId, times, snapshotId, deadline, abortSignal, input.referenceCrop ?? input.crop, input.referenceCropKeyframes, isReferenceAsset(input.assetId), {readId:batch.readId,save:async readId=>{batch.readId=readId;await save();}});
          if (!result) break;
          if (result.scores?.length !== times.length) throw new Error('The comparison returned incomplete scores. Retry this window.');
          scores.push(...result.scores.map((score, index) => ({ time: times[index], difference: Math.round(score.difference * 1000) / 10 })));
          for (const data of [result.image, ...(result.extraImages ?? [])]) if (data) {
            images.push({ label: `Reference (left) and timeline (right)${input.crop || input.referenceCrop || input.timelineCrop || input.referenceCropKeyframes ? ', cropped regions' : ''}, ${images.length + 1}`, data, mimeType: 'image/jpeg' });
            imageBytes += data.length;
          }
          completed += times.length;
          pending.shift();
          await save();
          if(batch.readId) await ctx.runMutation(internal.referenceReads.discard,{readId:batch.readId});
          if (imageBytes >= imageBudget) break;
          await queueBatch();
        }
      } catch(error) {
        if(abortSignal.aborted || (error as {data?:{code?:string}})?.data?.code==='REFERENCE_READ_INVALID' || (error instanceof Error && /could not be rendered|incomplete scores|comparison could not be made/.test(error.message))) await ctx.runMutation(internal.comparisonContinuations.expire,{id:receipt});
        throw error;
      }
      await save();
      const continueFrom = completed < requested.count ? requested.batch(completed)[0] : null;
      const { start, end, fps, times, ...settings } = input;
      const nextAction = continueFrom === null ? undefined : {tool:'compareReference',arguments:{projectId:run.projectId,...(timelineId?{timelineId}:{}),...(taskId?{taskId}:{}),...work,receipt}};
      if(!nextAction) await ctx.runMutation(internal.comparisonContinuations.expire,{id:receipt});
      return { status: nextAction ? (scores.length ? 'partial' : 'pending') : 'completed', revision, sourceFingerprint:progress.fingerprint, source: editSession.staged ? 'frozen draft' : 'frozen saved timeline', ...(input.crop ? { crop: input.crop } : {}), ...(input.referenceCrop ? { referenceCrop: input.referenceCrop } : {}), ...(input.timelineCrop ? { timelineCrop: input.timelineCrop } : {}), ...(input.referenceCropKeyframes ? { referenceCropKeyframes: input.referenceCropKeyframes } : {}), ...(input.times ? {} : { range: { start, end, fps: fps ?? 15 } }), requestedSamples: requested.count, samples: scores.length, scores, images, continueFrom, ...(nextAction ? { nextAction, reason: imageBytes >= imageBudget ? 'result_size' : 'time_budget' } : {}),
        next: nextAction ? `${imageBytes >= imageBudget ? 'Image result size' : 'Time budget'} reached. Call compareReference again using nextAction.arguments, starting at reference ${continueFrom}s with the same fps, crop settings and offset. Frozen source revision: ${revision}; continuations keep scoring this original frozen revision even after edits. The receipt expires after 10 minutes; zero samples are pending work, not verification. Inspect the returned pairs before continuing.` : stillReference ? 'Inspect the reference and built frame for composition, palette, hierarchy, materials and intent. Fix clear departures; exact pixels and a low difference score are not acceptance criteria. Check the planned motion separately with getFrames/checkPacing.' : 'Inspect every pair against the numbered inventory. Fix missing or wrong transitions, onset, speed, layers, counts and content with patchScene before tuning colors or offsets. Compare cropped details and run compareMotion for the section. Recheck after edits; close out every item as matched or explicitly off. A low score alone never establishes a match.' };
    }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    getFrames: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getFrames, description: "Look at your work: render 1 to 4 frames of the saved timeline at timeline seconds, composited exactly as the export draws them (scenes, footage, text, effects), and see them as images. For existing edits follow writing-scenes page edit-lanes for sampling; after builds use it at each key beat, to check that text is readable, nothing overflows or clips, brand fonts, colors and logo show, and frames are not empty; fix what is wrong before saying it is done. Each call takes 10 to 30 seconds; pick the moments that matter. With revision (from listRevisions), it renders the timeline as it was at that saved revision instead: use it to see what the user means by an earlier version before restoring it with restoreSection or restoreClip.", inputSchema: z.object({ resolution:z.union([z.literal(720),z.literal(1080)]).optional().describe('Default: budgeted preview. 1080 returns one full-size composition frame without resizing for precise layout inspection.'), times: z.array(z.number().min(0)).min(1).max(4).describe('Timeline seconds, inside the timeline.'), revision: z.number().int().min(0).optional().describe('A saved revision from listRevisions to look at instead of the current timeline.') }), execute: async (_ctx, { times, revision, resolution }) => {
      await editSession.wait();
      const snapshot = editSession.timeline;
      const result = await renderFrames(times, revision, undefined, resolution);
      if (revision === undefined && snapshot === editSession.timeline && result.revision === editSession.revision) fastReview.reviewed(result.frames.map(frame => frame.time), snapshot);
      return result;
    }, toModelOutput: async (ctx, options) => { const output = options.output as { revision: number; atRevision?: number; resolution?:number; frames: { time: number; image: string }[] }; return { type: 'content' as const, value: [
      { type: 'text' as const, text: `${output.resolution===1080?'1080p':'Preview'} frames of the ${output.atRevision !== undefined ? `timeline as it was at revision ${output.atRevision}` : `saved timeline (revision ${output.revision})`} at ${output.frames.map(frame => `${frame.time}s`).join(', ')}, in that order.` },
      ...await Promise.all(output.frames.map(frame => imagePart(ctx, frame.image, 'image/jpeg'))),
    ] }; } }),
    compareMotion: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.compareMotion, description: "Compare one section's rendered motion with its reference: camera path, start and duration, easing, overshoot, settle, transitions and element movement. SOURCE start/end (0.3 to 12 s); timelineStart aligns the build. Run for every section after compareReference, fix residuals with patchScene and repeat. Use independent referenceCrop and timelineCrop for a reference sub-panel versus a full-frame recreation; normalized regions are scaled to matching coordinates. crop remains shorthand for both, overridden by each explicit side. referenceCropKeyframes follows a moving reference region at interpolated SOURCE seconds (endpoints held), removing that framing motion from the measurement. Check background and foreground separately when they move differently. A regional map measures visible pixels, not semantic layer ownership; use trackReference on overlapping objects. No flags alone does not certify an inventory match.", inputSchema: z.object({ assetId: z.string().min(1), start: z.number().min(0), end: z.number().min(0), timelineStart: z.number().min(0), ...comparisonCropFields }).strict(), execute: async (_ctx, input) => motionMap(input) }),
    motionMap: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.motionMap, description: "Read how a film moves, not what it shows: the camera (zoom, pan, tilt, rotate of the whole frame) as GSAP keyframes with the measured ease (a named GSAP ease, or a CustomEase when none fits), transitions (cut, fade, wipe with direction, other) with duration and ease, elements moving against the background as GSAP tweens, content changing in place (appearing, disappearing, changing) with where and how much of the frame, holds, and for each camera move the change it answers (cause) or a flag when nothing changes when it starts or ends. Windows are up to 12 s, read at 30 fps. With assetId alone: a reference video (SOURCE seconds). Without assetId: the timeline (timeline seconds). Use referenceCrop and timelineCrop for independent normalized regions, crop as shorthand for both, and referenceCropKeyframes for a moving reference region in SOURCE seconds. With assetId and timelineStart: both, and differences: every place your timeline moves differently from the reference (a missing or extra camera move, a different ease, timing or amount, a missing or different transition, a move where the reference holds), each with the reference move as a GSAP tween at your time. Use it before animating from a reference (read every stretch), and after building to compare. If measurement is impossible or fails twice, pass off:{time,reason}; this clears coverage honestly and stays OFF, never matched, in later reports.", inputSchema: z.object({ assetId: z.string().optional().describe('A reference video in the project; omit to map the timeline.'), start: z.number().min(0).describe('SOURCE seconds of the reference, or timeline seconds without assetId.'), end: z.number().min(0).describe('Up to 12 s after start.'), timelineStart: z.number().min(0).optional().describe('With assetId: the timeline second that lines up with start, to compare the two.'), off: z.object({ time: z.number().min(0), reason: z.string().trim().min(12).max(500) }).strict().optional().describe('Declare this reference window OFF when measurement is impossible or after 2 failures. Required time inside the window and concrete reason persist in every report; OFF never means matched.'), ...comparisonCropFields }).strict(), execute: async (_ctx, input) => motionMap(input) }),
    checkPacing: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.checkPacing, description: "Check how the motion reads over time, which still frames cannot show: renders the timeline range at 10 samples a second (fps) and measures how much of the frame changes each second, how long each new picture holds before the next change, how zooms and pans speed up and slow down, and where cuts and single-frame flashes land. Returns the change per second and flagged moments with reasons: a visible change (a new headline, a panel filling in) followed by under about 1 s of hold, 3 or more changes within 1 s, changes landing in 3 or more different places within 1.5 s, a zoom or pan that starts or stops at full speed or is cut off mid-move, a camera move too fast to follow, a one-sample jump, a flash, or a still hold of 3 s or more. Run it on the changed range after building or changing motion, alongside getFrames, and fix what it flags. Long ranges run in chunks. Follow every nextAction until completed is true. Pending chunks keep running and are retrieved by checkId.", inputSchema: z.object({ checkId:z.string().min(1).optional().describe('Resume a pending saved chunk from nextAction.'), sourceCheckId:z.string().min(1).optional().describe('Continue the next chunk from this saved check’s frozen timeline; use nextAction.'), revision:z.number().int().nonnegative().optional().describe('Keep nextAction on the original saved revision.'), start: z.number().min(0).optional().describe('Timeline second to start at (default 0).'), end: z.number().positive().optional().describe('Timeline second to end at (default the end of the timeline).'), fps: z.number().min(2).max(30).optional().describe('Samples a second (default 10).') }).strict(), execute: async (_ctx, input) => checkPacing(input) }),
    getSound: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getSound, description: "Hear a timeline range, which frames cannot show: decodes the range's mix exactly as export mixes it and reports every clip that sounds there (sound effects, voice, music, footage audio) with its time and gain, the moments sounds start (onsets) with their level and which clip made them, momentary loudness (LUFS) and peak each 0.1 s with integrated loudness, silent stretches, and the spoken words with their timeline times. Use it to check what plays where before or after placing sound, music or narration.", inputSchema: z.object({ checkId:z.string().min(1).optional().describe('Resume a pending saved chunk from nextAction.'), sourceCheckId:z.string().min(1).optional().describe('Continue the next chunk from this saved check’s frozen timeline; use nextAction.'), revision:z.number().int().nonnegative().optional().describe('Keep nextAction on the original saved revision.'), start: z.number().min(0).optional().describe('Timeline second to start at (default 0).'), end: z.number().positive().optional().describe('Timeline second to end at (default the end of the timeline).') }).strict(), execute: async (_ctx, input) => listen(input, false) }),
    checkSound: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.checkSound, description: "Check that sound lands with the picture: samples the range's frames (30 a second by default) to find each visual hit (a click, a pop, a cut, something appearing) and matches every sound effect's onset to it. Flags a sound effect with nothing happening on screen, a strong visual hit with no sound, a sound more than 2 frames early or late (with the time to move it to), a different number of sounds and visual hits in one moment (two clicks shown, three click sounds), a sound effect landing on a spoken word, and clipping in the mix. Also returns everything getSound does. Run it on the range after adding, moving or retiming sound effects, and fix what it flags. Long ranges run in chunks. Follow every nextAction until completed is true. Pending chunks keep running and are retrieved by checkId.", inputSchema: z.object({ checkId:z.string().min(1).optional().describe('Resume a pending saved chunk from nextAction.'), sourceCheckId:z.string().min(1).optional().describe('Continue the next chunk from this saved check’s frozen timeline; use nextAction.'), revision:z.number().int().nonnegative().optional().describe('Keep nextAction on the original saved revision.'), start: z.number().min(0).optional().describe('Timeline second to start at (default 0).'), end: z.number().positive().optional().describe('Timeline second to end at (default the end of the timeline).'), fps: z.number().min(10).max(60).optional().describe('Picture samples a second (default 30, up to the timeline frame rate).') }).strict(), execute: async (_ctx, input) => listen(input, true) }),
    askUser: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.askUser, description: "Ask the user to choose between 2 to 6 options, shown as a choice card in the chat, instead of listing the options in text: a direction, a style, a length, which of several clips. Then end your turn; their choice arrives as their next message. Ask only what you cannot decide from the request, the project or memory. An option can show what it means: preview.time renders the timeline at that second as a picture in the card (build each look on the timeline first, for example style previews, then point each option at its moment); background is a candidate number from this turn's previewBackgrounds, whose HTML preview becomes the option's picture (to ask about a film's background or look, call previewBackgrounds first and give each option its candidate number; never offer background looks as text alone); audio is a sample URL from listVoices, played in the card.", inputSchema: z.object({ question: z.string().trim().min(3).max(200), options: z.array(z.object({ label: z.string().trim().min(1).max(60), description: z.string().trim().max(140).optional(), preview: z.object({ time: z.number().min(0).describe('Timeline second to show as this option\'s picture.') }).strict().optional(), background: z.number().int().min(1).max(5).optional().describe('Candidate number from this turn\'s previewBackgrounds (1 is its first candidate); the card shows that candidate\'s HTML preview.'), audio: z.string().url().optional().describe('A voice sample URL exactly as listVoices returned it.') }).strict().refine(option => !(option.preview && option.background), { message: 'Give an option preview.time or background, not both.' })).min(2).max(6) }).strict(), execute: async (_ctx, rawInput) => {
      if (rawInput.options.some(option => option.audio && !option.audio.startsWith(`${mediaConfig().url}/read?`))) throw new Error('audio must be a sample URL from listVoices.');
      // A background option carries its candidate's standalone HTML, which the choice card shows in a sandboxed frame.
      // previewBackgrounds called in the same step may still be starting behind its lane checks; wait for it briefly.
      for (let waited = 0; !backgroundPreviewRun && rawInput.options.some(option => option.background !== undefined) && waited < 20_000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
      await backgroundPreviewRun?.catch(() => undefined);
      // An option that names a candidate's exact label gets its preview too.
      const input = { ...rawInput, options: rawInput.options.map(({ background, ...option }) => {
        if (background !== undefined && !backgroundPreviews[background - 1]) throw new Error(backgroundPreviews.length ? `background ${background} is not a candidate; this turn's previewBackgrounds returned ${backgroundPreviews.length}.` : 'Call previewBackgrounds in this turn before offering background options.');
        const named = backgroundPreviews.findIndex(candidate => candidate.label.toLowerCase() === option.label.toLowerCase());
        const match = background !== undefined ? background - 1 : !option.preview && !option.audio ? named : -1;
        return match >= 0 ? { ...option, html: backgroundPreviews[match].html } : option;
      }) };
      const times = input.options.flatMap(option => option.preview ? [option.preview.time] : []);
      if (!times.length) return { ...input, asked: true };
      const { frames } = await renderFrames(times);
      const images = await Promise.all(times.map((time, index) => {
        const frame = frames.find(item => Math.abs(item.time - time) < 1e-6) ?? frames[index];
        return publishPreview(Uint8Array.from(atob(frame.image.replace(/^data:[^,]*,/, '')), char => char.charCodeAt(0)), 'image/jpeg');
      }));
      let next = 0;
      return { question: input.question, asked: true, options: input.options.map(option => option.preview ? { ...option, image: images[next++] } : option) };
    } }),
    askBrandKit: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.askBrandKit, description: "Never when the user gave a video to recreate, clone or copy: that video supplies its own brand, words and UI. When a request needs a brand (a launch or feature film, product UI, the brand's colors or screens) and the user has more than one brand kit, or it is unclear which one they mean, show their kits as a choice card. Then end your turn; their pick arrives as their next message, and you use that kit's screens and blueprints yourself. With one kit, just use it; with none, offer to create one.", inputSchema: z.object({ question: z.string().trim().min(3).max(200).optional() }).strict(), execute: async (_ctx, input) => {
      const [kits, blueprints] = await Promise.all([ctx.runQuery(internal.brandKits.list, { ownerId: run.ownerId }), ctx.runQuery(internal.blueprints.listForTools, { ownerId: run.ownerId })]);
      return { question: input.question ?? 'Which brand is this for?', asked: true, kits: kits.map(kit => ({ kitId: kit._id, name: kit.name, ...(kit.sourceUrl ? { site: kit.sourceUrl } : {}), ...(kit.logo && kit.logo.length < 24_000 ? { logo: kit.logo } : {}), screens: (kit.screens ?? []).map(screen => screen.name), blueprints: blueprints.filter(item => item.kitId === kit._id).map(item => item.name) })) };
    } }),
    previewBackgrounds: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.previewBackgrounds, description: "Before the first addFilm of a new film when the user has not set a look (launch-films-motions skill, backgrounds page): render 3 to 5 background candidates with the film's real headline, each a base + optional structure + optional accent from the backgrounds page. Colors you leave out are derived from the project's brand kit with the page's formulas (the kit used by the timeline's scenes, else kitId, else the user's only kit, else the page's fallbacks). Returns each candidate's resolved hex values and its one-line recipe for updateBrief; then call askUser with one option per candidate, each with background set to the candidate's number, and end your turn. Build from the pick; on feedback like \"2 but warmer\" preview again. Nothing is placed on the timeline.", inputSchema: z.object({
      headline: z.string().trim().min(2).max(90).describe('The film\'s real headline text, as it will appear on screen.'),
      kitId: z.string().min(1).optional().describe('Brand kit to derive colors and the heading font from; defaults to the kit on the timeline\'s scenes.'),
      candidates: z.array(z.object({
        label: z.string().trim().min(1).max(60),
        base: z.string().trim().describe('Base canvas hex, for example #F7F5F1 warm paper, #F7F8FD cool white, #FFFFFF clean white, a tinted canvas, or #07060B dark.'),
        ink: z.string().trim().optional().describe('Headline color hex; default the kit foreground when dark, else #16141A (light on a dark base).'),
        structure: z.object({ kind: z.enum(BACKGROUND_STRUCTURES), spacing: z.number().int().min(12).max(160).optional().describe('Frame pixels at 1920 wide between lines or dots; default 64 cell grid, 24 dots, 80 floor.'), color: z.string().trim().optional().describe('Line or dot hex; default base darkened 7% (lines) or 13% (dots).') }).strict().optional(),
        accent: z.object({ kind: z.enum(BACKGROUND_ACCENTS), color: z.string().trim().optional().describe('Default: bloom mix(base, accent, 0.2), lit cells mix(base, accent, 0.08), pixels the kit accent.'), at: z.string().trim().max(20).optional().describe('Focal point "X% Y%" (default "50% 50%"); for pixelBleed the edge or corner it spills from (default bottom-left).') }).strict().optional(),
        note: z.string().trim().max(140).optional().describe('What this candidate is for, one line.'),
      }).strict()).min(3).max(5),
    }).strict(), execute: (_ctx, input) => {
      backgroundPreviews = [];
      const preview = (async () => {
        const sceneKit = editSession.timeline.clips.find(clip => clip.scene?.brand?.kitId)?.scene?.brand?.kitId;
        const kitId = input.kitId ?? sceneKit ?? await ctx.runQuery(internal.brandKits.list, { ownerId: run.ownerId }).then(kits => kits.length === 1 ? kits[0]._id : undefined);
        const kit = kitId ? await ctx.runQuery(internal.brandKits.get, { ownerId: run.ownerId, kitId }) : null;
        if (input.kitId && !kit) throw new Error('Brand kit not found. List kits with listBrandKits.');
        const roles = kitRoles(kit?.colors ?? []);
        const heading = kit?.fonts.find(font => font.role === 'heading') ?? kit?.fonts[0];
        const board: BackgroundBoard = { headline: input.headline, font: heading ? { family: heading.family, weight: heading.weight } : { family: 'Inter', weight: '600' }, recipes: input.candidates.map(candidate => resolveCandidate(candidate, roles)) };
        const lines = board.recipes.map(recipe => recipe.line);
        if (new Set(lines).size < lines.length) throw new Error('Two candidates resolve to the same recipe. Make each differ in base, structure or accent.');
        const candidates = board.recipes.map((recipe, index) => ({ ...recipe, html: candidateDocument(board, index) }));
        backgroundPreviews = candidates.map(candidate => ({ label: candidate.label, html: candidate.html }));
        return {
          headline: board.headline, font: board.font, kit: kit ? { kitId: kit._id, name: kit.name, roles } : null, candidates,
          next: 'Call askUser now with one option per candidate in this order: its label, its note as description, and background set to its number (1 to ' + candidates.length + '). End your turn. When the user picks, save that candidate\'s line with updateBrief and build from it.',
        };
      })();
      backgroundPreviewRun = preview;
      return preview;
    }, toModelOutput: (_ctx, options) => {
      // The model reads the recipes; each candidate's HTML stays in the step for askUser and MCP.
      const output = options.output as { candidates: { html?: string }[] } & Record<string, unknown>;
      return { type: 'json' as const, value: { ...output, candidates: output.candidates.map(({ html: _html, ...candidate }) => candidate) } as JSONValue };
    } }),
    measureScreen: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.measureScreen, description: "Read exact pixels from a brand kit screen before rebuilding it as a blueprint (launch-films-motions skill, blueprints page): the hex color at points, and where the color changes along horizontal (axis y: a row at y=at, from x..to x) or vertical (axis x: a column at x=at) lines, which gives the edges of panels, rows, buttons and gaps. Measure every box's width and height and its corner curve; never type sizes or colors by eye.", inputSchema: z.object({ kitId: z.string().min(1), screen: z.string().min(1), points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().max(60).optional() })).max(60).optional(), lines: z.array(z.object({ axis: z.enum(['x', 'y']), at: z.number(), from: z.number(), to: z.number(), label: z.string().max(60).optional() })).max(20).optional() }).strict().refine(input => (input.points?.length ?? 0) + (input.lines?.length ?? 0) > 0, { message: 'Measure at least one point or line.' }), execute: async (_ctx, input) => {
      const checkId = await ctx.runMutation(internal.blueprints.requestCheck, { ownerId: run.ownerId, projectId: run.projectId, mode: 'measure', ...input });
      const state = await blueprintCheck(checkId);
      return { screen: input.screen, width: state.result.width, height: state.result.height, colors: state.result.colors ?? [], edges: state.result.edges ?? [] };
    } }),
    compareScreen: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.compareScreen, description: "Render blueprint code (a responsive scene module whose pieces carry data-part names) at the kit screen's size in the real scene engine, and compare it with the screen pixel by pixel. Returns the overall match (share of pixels within 24/255), the score of every part worst first, the worst regions, the render and a diff image (mismatches in red). Fix the lowest parts first; text-heavy parts score lower than flat ones. Pass width and height to check another size. To re-check a saved blueprint, pass its name as blueprint instead of code.", inputSchema: z.object({ kitId: z.string().min(1), screen: z.string().min(1), code: z.string().min(1).optional(), blueprint: z.string().min(1).optional(), width: z.number().int().min(1).max(2560).optional(), height: z.number().int().min(1).max(2560).optional() }).strict().refine(input => !!input.code !== !!input.blueprint, { message: 'Pass code or blueprint, not both.' }), execute: async (_ctx, { blueprint, ...input }) => {
      const code = input.code ?? (await ctx.runQuery(internal.blueprints.getForTools, { ownerId: run.ownerId, kitId: input.kitId, name: blueprint! })).code;
      const checkId = await ctx.runMutation(internal.blueprints.requestCheck, { ownerId: run.ownerId, projectId: run.projectId, mode: 'compare', ...input, code });
      const { result } = await blueprintCheck(checkId);
      const parts = [...(result.parts ?? [])].sort((a, b) => (a.score ?? 100) - (b.score ?? 100));
      return { checkId, size: `${result.width}x${result.height}`, score: result.score, meanDiff: result.meanDiff, worstParts: parts.slice(0, 15), partCount: parts.length, regions: result.regions ?? [], images: [{ label: 'Render', data: result.image, mimeType: 'image/jpeg' }, ...(result.diff ? [{ label: 'Differences in red', data: result.diff, mimeType: 'image/jpeg' }] : [])] };
    }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    // Frame readings of a video: a labeled sheet the model looks at, an object tracked frame by frame, exact pixels.
    readFrames: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.readFrames, description: READ_TOOL_DESCRIPTIONS.readFrames, inputSchema: READ_TOOL_INPUTS.readFrames, execute: async (_ctx, input) => { try { if(lane==='clip'){if(input.fps!==undefined){const state=await ctx.runQuery(internal.clipping.completionState,{...clippingRun});if(!('accepted' in state)||!state.accepted||input.end-input.start>1||(input.end-input.start)*input.fps>29)return {success:false,error:'Frame-level source reads are only for framing after planClips accepts candidates: at most 1 second and 30 frames. Action discovery uses targeted inspectVideo windows; finished-tab checkClip QA is optional.'};}if(input.momentsOnly||(input.fps===undefined&&(input.times?input.times.length>12:(input.count??3)>3||input.end-input.start>60)))return {success:false,error:'Clip discovery/framing reads 1-3 stills per candidate, or up to 12 explicit times across candidates in one call. Use stillsOnly:true; no fps or momentsOnly. Use scoped checkClip only for requested finished-tab QA.'};input={...input,count:input.count??3,stillsOnly:true};} return await readTool('readFrames', input); } catch (error) { if (abortSignal.aborted) throw error; return { success: false, error: error instanceof Error ? error.message : 'The frames could not be read.' }; } }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    listenReference: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listenReference, description: READ_TOOL_DESCRIPTIONS.listenReference, inputSchema: READ_TOOL_INPUTS.listenReference, execute: async (_ctx, input) => readTool('listenReference', input) }),
    trackReference: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.trackReference, description: READ_TOOL_DESCRIPTIONS.trackReference, inputSchema: READ_TOOL_INPUTS.trackReference, execute: async (_ctx, input) => readTool('trackReference', input), toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    measureFrame: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.measureFrame, description: READ_TOOL_DESCRIPTIONS.measureFrame, inputSchema: READ_TOOL_INPUTS.measureFrame, execute: async (_ctx, input) => readTool('measureFrame', input), toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    matchFont: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.matchFont, description: READ_TOOL_DESCRIPTIONS.matchFont, inputSchema: READ_TOOL_INPUTS.matchFont, execute: async (_ctx, input) => readTool('matchFont', input), toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    traceShape: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.traceShape, description: READ_TOOL_DESCRIPTIONS.traceShape, inputSchema: READ_TOOL_INPUTS.traceShape, execute: async (_ctx, input) => readTool('traceShape', input), toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    // Real logos and icons, fetched (convex/icons.ts), so no brand mark or app icon is ever drawn by hand.
    findIcon: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.findIcon, description: "Get a real brand logo, app icon or UI icon as SVG markup to inline in a scene: findIcon('gmail'), findIcon('notion'), findIcon('slack'), findIcon('send', style ui). Use it for every product logo or app icon a film shows or a reference contains; never draw or approximate one by hand. style logo (default) returns the official full-color logo or app symbol; glyph the brand's single-color mark with its brand hex (simple-icons), or a full-color emoji object (Noto, Apache-2.0; Fluent Emoji, MIT); ui a generic interface icon (Lucide, Tabler, Phosphor, Material Symbols, Heroicons, MDI). Returns svg (no fixed size: set width and height in CSS, keep aspect), brandColor, colors, source, license (CC0, MIT, ISC or Apache-2.0), alternatives, and a preview image of the top matches, the returned one first; pass an exact id (logos:slack-icon, simple-icons:gmail, noto:trophy, fluent-emoji:trophy) as name to take it instead. color recolors single-color glyph or ui icons; emoji artwork keeps its colors. Unsupported prefixes return the license allow-list. Brand logos are trademarks: show each as it is, to name that product, at its own colors and proportions; never recolor, distort, restyle, animate its parts apart or combine it with other marks, and never imply endorsement. Scenes cannot load from the network, so the markup goes into the scene code itself.", inputSchema: z.object({ name: z.string().trim().min(1).max(80).describe('Brand or product (gmail, notion, openai), a thing for a UI icon (send, calendar), or an exact id from alternatives.'), style: z.enum(['logo', 'glyph', 'ui']).optional(), color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/).optional().describe('Glyph or ui icons only.') }).strict(), execute: async (_ctx, input) => {
      if (input.color && input.style !== 'glyph' && input.style !== 'ui') throw new Error('color recolors glyph and ui icons only; a full-color logo keeps its own colors.');
      return await ctx.runAction(internal.icons.find, input);
    }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    saveBlueprint: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.saveBlueprint, description: "Save the code a finished compareScreen scored as a blueprint in its brand kit, under a short name ('Editor', 'Dashboard'). Its parts and score come from that compare; pass the colors and edges you measured with labels, so the kit shows how it was built. Saving a name again replaces it.", inputSchema: z.object({ checkId: z.string().min(1), name: z.string().trim().min(1).max(60), colors: z.array(z.object({ label: z.string().max(60), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), x: z.number(), y: z.number() })).max(60).optional(), edges: z.array(z.object({ label: z.string().max(60), axis: z.enum(['x', 'y']), at: z.number() })).max(60).optional() }).strict(), execute: async (_ctx, input) => ctx.runMutation(internal.blueprints.saveFromCheck, { ownerId: run.ownerId, checkId: input.checkId, name: input.name, colors: input.colors ?? [], edges: input.edges ?? [] }) }),
    listBlueprints: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listBlueprints, description: "List the user's blueprints (brand UI rebuilt as live scene code with named parts), optionally for one kit: name, source screen, size, match score and part names.", inputSchema: z.object({ kitId: z.string().optional() }).strict(), execute: async (_ctx, input) => ({ blueprints: await ctx.runQuery(internal.blueprints.listForTools, { ownerId: run.ownerId, ...input }) }) }),
    getBlueprint: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getBlueprint, description: "Load one blueprint's code and parts to mount it in a scene: render the whole UI, or reach in for named parts ([data-part=composer]) to animate, replace or transition them. Pass preview (a size) to see it rendered.", inputSchema: z.object({ kitId: z.string().min(1), name: z.string().min(1), preview: z.object({ width: z.number().int().min(1).max(2560), height: z.number().int().min(1).max(2560) }).optional() }).strict(), execute: async (_ctx, input) => {
      const blueprint = await ctx.runQuery(internal.blueprints.getForTools, { ownerId: run.ownerId, kitId: input.kitId, name: input.name });
      if (!input.preview) return blueprint;
      const checkId = await ctx.runMutation(internal.blueprints.requestCheck, { ownerId: run.ownerId, projectId: run.projectId, kitId: input.kitId, mode: 'render', code: blueprint.code, ...input.preview });
      const { result } = await blueprintCheck(checkId);
      return { ...blueprint, images: [{ label: `Preview at ${result.width}x${result.height}`, data: result.image, mimeType: 'image/jpeg' }] };
    }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    readSkill:createTool({metadata:EDITOR_TOOL_DEFINITIONS.readSkill,description:"Load one known supporting skill or page on demand and enable its tools. Reuse current reads. Preserves the primary workflow and its deliverable. Find skills with discoverCapabilities.",inputSchema:z.object({name:z.string().min(1),page:z.string().max(80).optional()}),execute:async(_ctx,{name,page})=>{const instructions=laneSkill(name,page,mcpSurface);await loadCapability(name);return {name,...(page?{page}:{}),lane,instructions};}}),
    addScene: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addScene, description: "Add one animated scene: a TypeScript module (code) that builds plain HTML and animates it on a GSAP timeline, rendered full-frame on a free V layer for start..start+duration timeline seconds. Read writing-scenes first, plus launch-films-motions for launch and feature films. Then give it matching sound as that skill says. For a film (a launch film, a recreation, anything longer than one idea), use addFilm instead: one clip, one timeline, sections as markers. Returns compile errors for invalid code; save immediately.", inputSchema: z.object({ title: z.string().trim().min(1).max(SCENE_LIMITS.title), code: z.string().min(1), start: z.number().min(0), duration: z.number().positive().max(120), track: z.number().int().min(1).max(24).optional(), brandKitId: z.string().optional().describe('Brand kit whose fonts, colors and logo the scene receives as `brand`.'), media: sceneMediaInput.optional(), blueprints: sceneBlueprintInput.optional() }), execute: async (_ctx, { title, code, brandKitId, media, blueprints, ...timing }) => { checkSceneCode(code); const brand = brandKitId ? await sceneBrandSnapshot(ctx, run.ownerId, brandKitId) : undefined; const images = media ? sceneMedia(media) : undefined; const mounted = blueprints?.length ? await sceneBlueprints(brandKitId, blueprints) : undefined; return checkpoint(t => placeScene(t, { title, code, ...timing, brand, media: images, blueprints: mounted })); } }),
    editScene: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.editScene, description: "Replace an existing scene clip's code and/or title, or attach or refresh its brand kit, preserving its timing and layer. A scene keeps its brand kit as it was when attached; pass brandKitId again to pick up later kit changes. Read writing-scenes (and launch-films-motions for films) and inspectClip for the current code first. If the edit changes the scene's timing or motion, update its existing generated sound with editSound in the same turn (or generate one if it has none). For a change to part of a film or scene, use patchScene instead of retyping the code; new code on a film clip replaces the whole film in every clip of it, and its section markers follow the new section() calls. Title-only edits need no scope. A code change isolated to one section infers scope; shared-code edits need scope for the requested sections. Binding-only refreshes without scope must render every existing section unchanged. Returns compile errors for invalid code; save immediately.", inputSchema: z.object({ clipId: z.string(), scope: scopeInput.optional(), title: z.string().trim().min(1).max(SCENE_LIMITS.title).optional(), code: z.string().min(1).optional(), brandKitId: z.string().nullable().optional().describe('Attach or refresh a brand kit on the scene; null removes it.'), media: sceneMediaInput.nullable().optional().describe('Replace the scene\'s images; null removes them all.'), blueprints: sceneBlueprintInput.nullable().optional().describe('Replace the mounted blueprints (refreshing their code from the kit); null removes them.') }).refine(input => input.title !== undefined || input.code !== undefined || input.brandKitId !== undefined || input.media !== undefined || input.blueprints !== undefined, { message: 'Specify a title, code, brandKitId, media or blueprints.' }), execute: async (_ctx, { clipId, scope, title, code, brandKitId, media, blueprints }) => { let sectionMarkers: SectionMarkerChanges | undefined; if (code !== undefined) checkSceneCode(code); const brand = brandKitId ? await sceneBrandSnapshot(ctx, run.ownerId, brandKitId) : undefined; const images = media ? sceneMedia(media) : undefined; const kitId = brandKitId ?? find(editSession.timeline, clipId).scene?.brand?.kitId; const mounted = blueprints?.length ? await sceneBlueprints(kitId, blueprints) : undefined; const change = (t: Timeline) => { const clip = find(t, clipId); if (clip.kind !== 'scene' || !clip.scene) throw new Error('Choose a scene clip.'); const { brand: current, media: currentMedia, blueprints: currentBlueprints, ...scene } = clip.scene; const next = brandKitId === null ? undefined : brand ?? current; const nextMedia = media === null ? undefined : images ?? currentMedia; const nextCode = code ?? scene.code, nextBlueprints = blueprints === null ? undefined : mounted ?? currentBlueprints; if (code !== undefined && scene.film) checkSectionCalls(nextCode, scene.film.duration); const shown = (other: Clip['scene'] & {}, own: boolean) => ({ ...(({ brand: _b, media: _m, blueprints: _p, ...rest }) => rest)(other), title: own ? title ?? other.title : other.title, code: nextCode, ...(next ? { brand: next } : {}), ...(nextMedia?.length ? { media: nextMedia } : {}), ...(nextBlueprints?.length ? { blueprints: nextBlueprints } : {}) }); /* Every clip of a film shares one code: its code, brand, media and blueprints change in all of them. */ if (scene.film) { const synced = syncFilmSectionMarkers({ ...t, clips: t.clips.map(other => other.kind === 'scene' && other.scene?.code === scene.code ? { ...other, scene: shown(other.scene, other.id === clipId) } : other) }, scene.code, nextCode); sectionMarkers = synced.changes; return synced.timeline; } return patchClip(t, clipId, { scene: shown(clip.scene, true) }); }; const scoped = await scopedChange(clipId, scope, change, 'edit'); if ('refusal' in scoped) return scoped.refusal; const saved = await checkpoint(change); return { ...saved, ...scoped, ...(sectionMarkers ? { sectionMarkers } : {}) }; }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    addScenes: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addScenes, description: "Add several separate scene clips in one call, saved together: standalone moments such as title cards or overlays, each a plain HTML + GSAP module like addScene. For a film whose motion runs from section to section (launch films, recreations), use addFilm instead. Each scene saves or fails on its own: fix a failed one with addScene. Read writing-scenes and launch-films-motions first.", inputSchema: z.object({ brandKitId: z.string().optional().describe('Brand kit whose fonts, colors and logo every scene receives as `brand`.'), scenes: z.array(z.object({ title: z.string().trim().min(1).max(SCENE_LIMITS.title), code: z.string().min(1), start: z.number().min(0), duration: z.number().positive().max(120), track: z.number().int().min(1).max(24).optional(), media: sceneMediaInput.optional(), blueprints: sceneBlueprintInput.optional() })).min(1).max(8) }), execute: async (_ctx, { brandKitId, scenes }) => {
      const brand = brandKitId ? await sceneBrandSnapshot(ctx, run.ownerId, brandKitId) : undefined;
      // Check every scene before saving, so one mistake does not cost the rest of the film.
      const ready = await Promise.all(scenes.map(async ({ media, blueprints, ...scene }) => { try { checkSceneCode(scene.code); return { ...scene, brand, media: media ? sceneMedia(media) : undefined, blueprints: blueprints?.length ? await sceneBlueprints(brandKitId, blueprints) : undefined }; } catch (error) { return { title: scene.title, error: error instanceof Error ? error.message : String(error) }; } }));
      const results: ({ title: string; clipId: string } | { title: string; error: string })[] = ready.map(scene => 'error' in scene ? { title: scene.title, error: String(scene.error) } : { title: scene.title, clipId: '' });
      const saved = await checkpoint(timeline => ready.reduce((t, scene, index) => {
        if ('error' in scene) return t;
        try { const id = crypto.randomUUID(), next = placeScene(t, { ...scene, id }); results[index] = { title: scene.title, clipId: id }; return next; }
        catch (error) { results[index] = { title: scene.title, error: error instanceof Error ? error.message : String(error) }; return t; }
      }, timeline));
      const failed = results.filter(item => 'error' in item);
      if (failed.length === results.length) throw new Error(failed.map(item => `${item.title}: ${(item as { error: string }).error}`).join('\n'));
      return { ...saved, scenes: results, ...(failed.length ? { note: `${failed.length} of ${results.length} scenes were not saved; fix each with addScene. The others are saved.` } : {}) };
    } }),
    addFilm: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addFilm, description: "Build a motion film (a launch film, a recreation, any motion piece longer than one idea) as one scene clip for its whole length: one plain HTML + GSAP module (no React or JSX) whose animation runs on one continuous timeline, so moves flow from section to section with no cuts or transition clips. Write each section as section('Title', start, duration, (tl) => { ... }) with number literals for start and duration in film seconds; its tl counts from the section's start. sections name the same parts (title and film second each starts); every section() call must match one of them by title and start, and they become timeline markers the user and you can point at. A section owns its call and the top-level helpers only it uses, so inspectClip and patchScene can address it and an approved section stays locked; everything else in the module (building the HTML, moves spanning sections on the outer tl) is shared. Change the film afterwards with patchScene (small exact edits); never rewrite it. Keep each call under about 20k tokens (60,000 characters) of code: for a longer film, write the first part now with a comment marker such as // --- more sections where the rest goes, set builtThrough to the end of what you wrote (later sections need no call yet), then add each next section with patchScene insert 'before' that marker. Read launch-films-motions and writing-scenes page films first.", inputSchema: z.object({ title: z.string().trim().min(1).max(SCENE_LIMITS.title).describe("The film's name."), start: z.number().min(0).describe('Timeline second where the film starts.'), duration: z.number().positive().max(180).describe("The film's length in seconds."), builtThrough: z.number().positive().max(180).optional().describe('When starting a film section by section: the end, in film seconds, of the part implemented in this call. The clip keeps its full duration; unread later sections are added with patchScene.'), sections: z.array(z.object({ title: z.string().trim().min(1).max(120), at: z.number().min(0).describe('Film second where this section starts.') })).max(24).optional().describe('Named sections, placed as timeline markers.'), track: z.number().int().min(1).max(24).optional(), brandKitId: z.string().optional().describe('Brand kit whose fonts, colors and logo the film receives as `brand`.'), media: sceneMediaInput.optional(), blueprints: sceneBlueprintInput.optional(), code: z.string().min(1).describe('The film module, written last: the editor shows each section as it is written.') }), execute: async (_ctx, { title, code: written, start, duration, builtThrough, sections: listed, track, brandKitId, media, blueprints: names }) => {
      if (builtThrough !== undefined && builtThrough > duration) throw new Error('builtThrough must be inside the film duration.');
      await editSession.wait();
      const reference = LANES[lane].referenceMotion === 'required' ? referenceAssetId() : undefined;
      if (reference) { const refusal = await motionGate(reference, start, start + (builtThrough ?? duration)); if (refusal) return refusal; }
      // Section and shot timing written as beat(n)/downbeat(n)/accent(n) is saved as the literals the engine reads.
      const timing = resolveBeatTiming(written, newFilmBeats(editSession.timeline, start, duration), true), code = timing.code;
      // A section named in `sections` takes its start from its beat-timed call (the literal is floored to the millisecond).
      const sections = listed?.map(item => ({ ...item, at: timing.resolved.find(call => call.title.trim().toLowerCase() === item.title.trim().toLowerCase())?.start ?? item.at }));
      checkSceneCode(code);
      checkFilmSections(code, duration, sections ?? [], builtThrough ?? duration);
      const brand = brandKitId ? await sceneBrandSnapshot(ctx, run.ownerId, brandKitId) : undefined, images = media ? sceneMedia(media) : undefined, mounted = names?.length ? await sceneBlueprints(brandKitId, names) : undefined;
      let placed: ReturnType<typeof placeFilm> | undefined;
      const saved = await checkpoint(t => { const blueprints = mounted; placed = placeFilm(t, { title, start, duration, sections, track, scene: { code, ...(brand ? { brand } : {}), ...(images?.length ? { media: images } : {}), ...(blueprints?.length ? { blueprints } : {}) } }); if (reference) {
        const clip = find(placed.timeline, placed.clip.id);
        placed.timeline = patchClip(placed.timeline, clip.id, { scene: { ...clip.scene!, film: { ...clip.scene!.film!, referenceAssetId: reference, referenceStart: start, builtThrough: builtThrough ?? duration } } });
      }
      return placed.timeline; });
      return { ...saved, scenes: [{ clipId: placed!.clip.id, title, start, duration }], sections: placed!.markers, ...(timing.resolved.length ? { beatTiming: timing.resolved } : {}), note: `One film clip of ${duration}s${placed!.markers.length ? ` with ${placed!.markers.length} section markers` : ''}. Check each section and every move between them with getFrames; change the film with patchScene.` };
    } }),
    patchScene: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.patchScene, description: "Change a film or scene with small edits. The {find,replace,all?,insert?} edits apply snippets sequentially, tolerating line indentation differences when the match is unique; a missing match returns nearby exact numbered lines and changes nothing. Pass section (marker label or id) to search only its section() call and the top-level declarations it uses. Or use edits [{lines:{start,end},replace}] to replace inclusive absolute lines without quoting old code; all line ranges in a call refer to the same inspected snapshot and must not overlap. Do not mix line and snippet edits. Pass expectedRevision from inspectClip: nonoverlapping changes since that snapshot are merged, while overlapping changed lines are refused; reinspect after a successful patch. section also supplies scope unless you pass scope explicitly. Shared code and edits across section boundaries return transition warnings; keep spanning tweens on the shared timeline and check both sides. Without markers, use whole-scene lines. Every clip sharing the code gets the change. A film's section markers follow its section() calls: moving, adding, renaming or deleting a call moves, adds, renames or removes its marker (returned as sectionMarkers), so never realign them with moveMarker, addMarker or removeMarkers. insert before/after keeps the selected snippet or lines; a new section is a section('Title', start, duration, (tl) => { ... }) call with literal timing inserted before the film's marker comment. The result compiles before saving, and a film's section() calls must keep literal timing inside the film without overlapping; any failure saves nothing. Update generated sound with editSound when timing or motion changes. A change isolated to one section infers its scope; shared-code edits need explicit scope for the requested sections. Every other section stays locked by the visual guard. Use patchScene after the first build, including inserting later parts at markers; keep each call under about 20k tokens of code.", inputSchema: z.object({ clipId: z.string(), builtThrough: z.number().positive().max(600).optional().describe('When extending a recreation, the implemented end in film seconds. Motion reads or timed OFF declarations must cover it.'), scope: scopeInput.optional(), section: codeSectionInput.optional(), expectedRevision: z.number().int().min(0).optional().describe('Revision from inspectClip. Edits rebase across unchanged lines; changes to the same lines or insertion boundaries are refused.'), edits: sceneEditsInput }), execute: async (_ctx, { clipId, edits, scope, section, expectedRevision, builtThrough }) => {
      let updated: string[] = [], characters = 0, warnings: string[] = [], sectionMarkers: SectionMarkerChanges | undefined, beatTiming: ResolvedTiming[] | undefined;
      await editSession.wait();
      const currentClip = find(editSession.timeline, clipId), film = currentClip.scene?.film;
      const reference = referenceMotionEnabled() ? film?.referenceAssetId ?? (film && LANES[lane].referenceMotion === 'required' ? referenceAssetId() : undefined) : undefined;
      let implemented = film?.builtThrough ?? film?.duration ?? currentClip.duration;
      if (film && builtThrough !== undefined && builtThrough > film.duration) throw new Error('builtThrough must be inside the film duration.');
      if (film && (scope ?? section) !== undefined) implemented = Math.max(implemented, ...resolveScope(editSession.timeline, currentClip, (scope ?? section)!).map(range => range.end));
      implemented = Math.min(film?.duration ?? currentClip.duration, Math.max(implemented, builtThrough ?? 0));
      const referenceStart = film?.referenceStart ?? currentClip.start - currentClip.sourceStart;
      if (reference) { const refusal = await motionGate(reference, referenceStart, referenceStart + implemented); if (refusal) return refusal; }
      const withProgress = (timeline: Timeline) => {
        if (!reference || !film) return timeline;
        const code = find(timeline, clipId).scene?.code;
        return { ...timeline, clips: timeline.clips.map(clip => clip.scene?.code === code && clip.scene?.film ? { ...clip, scene: { ...clip.scene, film: { ...clip.scene.film, referenceAssetId: reference, referenceStart, builtThrough: implemented } } } : clip) };
      };
      let baseClip: Clip | undefined;
      const rebased = expectedRevision !== undefined && expectedRevision !== editSession.revision;
      if (rebased) {
        const { change } = await ctx.runQuery(internal.assistant.revisionChanges, { ...run, revision: expectedRevision, clipId }) as { change: { before: Clip | null } | null };
        baseClip = change ? change.before ?? undefined : find(editSession.timeline, clipId);
        if (!baseClip?.scene) throw new Error(`This scene did not exist at revision ${expectedRevision}. Read inspectClip for its current code. Nothing was changed.`);
      }
      const change = (t: Timeline) => {
        const clip = find(t, clipId);
        if (clip.kind !== 'scene' || !clip.scene) throw new Error('Choose a scene clip.');
        const patch = (code: string) => {
          // Beat-timed headers in the new text resolve to literals; code the edits leave alone keeps what it has.
          const beats = clipBeats(t, clip), found: ResolvedTiming[] = [], resolvedEdits = edits.map(item => { const timing = resolveBeatTiming(item.replace, beats, true); found.push(...timing.resolved); return { ...item, replace: timing.code }; });
          beatTiming = found.length ? found : undefined;
          const source = baseClip ?? clip, result = patchSceneCode(t, source, resolvedEdits, { section });
          warnings = result.warnings;
          return baseClip ? rebaseSceneCode(sceneCodeSource(baseClip), code, result.code) : result.code;
        };
        const next = patch(clip.scene.code);
        if (next === clip.scene.code) throw new Error('These edits change nothing.');
        checkSceneCode(next);
        if (clip.scene.film) checkSectionCalls(next, clip.scene.film.duration);
        const result = withPatchedScene(t, clip.scene.code, next);
        updated = result.updated; characters = next.length; sectionMarkers = result.sectionMarkers;
        return withProgress(result.timeline);
      };
      const scoped = await scopedChange(clipId, scope ?? section, change, 'patch');
      if ('refusal' in scoped) return scoped.refusal;
      const saved = await checkpoint(change);
      return { ...saved, editsApplied: edits.length, updatedClips: updated, characters, ...scoped, ...(sectionMarkers ? { sectionMarkers } : {}), ...(rebased ? { rebasedFromRevision: expectedRevision } : {}), ...(warnings.length ? { warnings } : {}), ...(beatTiming ? { beatTiming } : {}) };
    }, toModelOutput: (ctx, options) => blueprintImages(ctx, options.output) }),
    addMedia: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addMedia, description: "Add this project's uploaded video/image on a shared visual track (1–24), or audio on an audio track (1–12); save immediately. Adding a video also adds its extracted audio as a linked clip; never add that audio again. Higher V tracks draw above lower ones; one V track can hold different visual kinds, and there is no separate overlay group.", inputSchema: z.object({ assetId: z.string(), track: z.number().int().min(1).max(24).optional(), start: z.number().min(0), duration: z.number().positive(), sourceStart: z.number().min(0) }), execute: async (_ctx, input) => checkpoint(t => { const asset = assets.find(a => a._id === input.assetId); if (!asset) throw new Error("Choose media from this project"); if (recovering && t.clips.some(clip => clip.assetId === input.assetId && Math.abs(clip.start-input.start) < 1/t.fps && Math.abs(clip.duration-input.duration) < 1/t.fps && Math.abs(clip.sourceStart-input.sourceStart) < 1/t.fps)) return t; const id = crypto.randomUUID(); const next = addMediaClip(t, { ...asset, duration: input.duration }, id, input.start, input.track ?? 1); return patchClip(next, id, { sourceStart: input.sourceStart, duration: input.duration,...(lane==='clip'&&asset.kind==='video'&&t.aspectRatio==='vertical'?{fit:'cover' as const}:{}) }); }) }),
    addSoundEffect: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addSoundEffect, description: "Place one recorded CC0 library sound (ids in the effect enum) at its full length on a free A layer at timeline seconds at, frame-snapped; save immediately. Use ONLY when the user explicitly asks for a realistic or recorded sound that the library has (camera shutter, phone vibrate, clock, lock, water, ambience such as city, ocean or server room) or names a library sound; place it at exactly the time they give or the moment they describe. Never add library sounds on your own initiative or mix them into motion-graphics sound design: generate those with generateSound. gain is the clip volume 0..2 (default 0.7). Returns the clip and any audible non-effect audio it overlaps.", inputSchema: z.object({ effect: z.enum(STOCK_AUDIO_IDS), at: z.number().min(0), gain: z.number().min(0).max(2).optional() }), execute: async (_ctx, { effect, at, gain = .7 }) => {
      const sound = stockAudio(effect)!;
      let asset = assets.find(item => item.r2Key === sound.r2Key);
      if (!asset) { asset = await ctx.runMutation(internal.assistant.attachRunStockAudio, { ...run, catalogId: effect }); assets.push(asset); }
      return { ...await placeEffectSound(asset._id, sound.duration, at, gain), effect, name: sound.name, duration: sound.duration };
    } }),
    listBrandKits: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listBrandKits, description: "List the user's saved brand kits (name, source, fonts, colors, whether a logo and a confirmed brand context are saved). Check this first for any branded scene, launch or product video: if a kit fits, ask the user whether to use it; if none does, ask for their website URL or theme and create one. Read the launch-films-motions skill (its brand-kit page) first. No timeline changes.", inputSchema: z.object({}), execute: async () => { const kits = await ctx.runQuery(internal.brandKits.list, { ownerId: run.ownerId }); return { kits: kits.map(kit => ({ kitId: kit._id, name: kit.name, sourceUrl: kit.sourceUrl, fonts: [...new Set(kit.fonts.map(font => `${font.family} (${font.role})`))], colors: kit.colors.length, logo: !!kit.logo, context: !!kit.context, updatedAt: new Date(kit.updatedAt).toISOString() })) }; } }),
    getBrandKit: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getBrandKit, description: "Read one brand kit: named colors, font families by role and weights, the logo (inline SVG markup is returned so you can animate its paths), the scraped landing-page copy, and the saved brand context (one product text: what it is, the problem, the features), its screens, and its blueprints (the product UI already rebuilt as live code with named parts: mount one with getBlueprint instead of rebuilding that UI). No timeline changes.", inputSchema: z.object({ kitId: z.string() }), execute: async (_ctx, { kitId }) => { const kit = await ctx.runQuery(internal.brandKits.get, { ownerId: run.ownerId, kitId }); if (!kit) throw new Error('Brand kit not found. List kits with listBrandKits.'); return { kitId: kit._id, name: kit.name, sourceUrl: kit.sourceUrl, colors: kit.colors, fonts: kit.fonts.map(font => ({ family: font.family, weight: font.weight, role: font.role })), logo: kit.logo ? (kit.logo.startsWith('<svg') ? { kind: 'svg', markup: kit.logo } : { kind: 'image', size: kit.logo.length }) : null, copy: kit.copy, context: kit.context ?? null, screens: (kit.screens ?? []).map(screen => ({ name: screen.name, width: screen.width, height: screen.height, note: screen.note })), blueprints: (await ctx.runQuery(internal.blueprints.listForTools, { ownerId: run.ownerId, kitId: kit._id })).map(blueprint => ({ name: blueprint.name, screen: blueprint.screen, parts: blueprint.parts })) }; } }),
    createBrandKit: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.createBrandKit, description: "Create and save a named brand kit for this user. Give url to scrape the website's fonts (downloaded and stored), colors, logo and copy; and/or give colors, Google Fonts family names and an SVG logo for a theme the user describes (these override what the scrape found). Returns what was found plus notes on anything missing. Show the user the result and confirm before using it; then draft the brand context from the copy and confirm it (updateBrandKit). No timeline changes.", inputSchema: z.object({ name: z.string().trim().min(1).max(BRAND_LIMITS.name), url: z.string().url().optional(), colors: z.array(z.object({ name: z.string().min(1).max(40), value: z.string().min(3).max(BRAND_LIMITS.colorValue) })).max(BRAND_LIMITS.colors).optional(), fonts: z.array(z.object({ family: z.string().min(1).max(80), role: z.enum(['heading', 'body', 'other']) })).max(3).optional().describe('Google Fonts families.'), logoSvg: z.string().max(BRAND_LIMITS.logo).optional() }).refine(input => input.url || input.colors || input.fonts, { message: 'Give a url, or colors and fonts.' }), execute: async (_ctx, { name, url, colors, fonts, logoSvg }) => {
      const scraped = url ? await scrapeBrand(ctx, url) : undefined;
      const manual = fonts?.length ? await googleFonts(ctx, fonts) : undefined;
      const logo = logoSvg?.trim().startsWith('<svg') ? logoSvg.trim() : scraped?.logo;
      const kitId = await ctx.runMutation(internal.brandKits.create, { ownerId: run.ownerId, name, ...(scraped ? { sourceUrl: scraped.sourceUrl, copy: scraped.copy } : {}), colors: colors ? cleanColors(colors) : scraped?.colors ?? [], fonts: manual?.fonts.length ? manual.fonts : scraped?.fonts ?? [], ...(logo ? { logo } : {}) });
      const kit = await ctx.runQuery(internal.brandKits.get, { ownerId: run.ownerId, kitId });
      return { kitId, name, colors: kit?.colors, fonts: kit?.fonts.map(font => ({ family: font.family, weight: font.weight, role: font.role })), logo: logo ? (logo.startsWith('<svg') ? 'svg' : 'image') : null, copy: scraped?.copy, notes: [...(scraped?.notes ?? []), ...(manual?.missing.length ? [`Not found on Google Fonts: ${manual.missing.join(', ')}.`] : [])] };
    } }),
    updateBrandKit: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.updateBrandKit, description: "Change a saved brand kit: rename it, replace its colors, replace its fonts with Google Fonts families, replace the logo SVG, or save the brand context once the user confirms it (one product text: what it is, the problem it solves, the features worth showing), or save product screenshots from this project as the kit's screens (addScreens) so later videos reuse them. Scenes keep the kit as it was when they were saved; refresh one with editScene brandKitId. No timeline changes.", inputSchema: z.object({ kitId: z.string(), name: z.string().trim().min(1).max(BRAND_LIMITS.name).optional(), colors: z.array(z.object({ name: z.string().min(1).max(40), value: z.string().min(3).max(BRAND_LIMITS.colorValue) })).max(BRAND_LIMITS.colors).optional(), fonts: z.array(z.object({ family: z.string().min(1).max(80), role: z.enum(['heading', 'body', 'other']) })).min(1).max(3).optional(), logoSvg: z.string().max(BRAND_LIMITS.logo).optional(), context: z.object({ product: z.string().max(BRAND_LIMITS.contextText).describe('Everything about the product in one text: what it is, the problem it solves, the features worth showing.') }).optional(), addScreens: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][\w-]{0,30}$/).describe('How scenes read it: media.<name>, e.g. editor, dashboard.'), assetId: z.string().describe('An image in this project.'), note: z.string().max(200).optional().describe('What the screen shows.') })).max(BRAND_LIMITS.screens).optional().describe('Save product screenshots from this project to the kit, so every video for this brand can use them. A screen with the same name is replaced.'), removeScreens: z.array(z.string()).max(BRAND_LIMITS.screens).optional() }), execute: async (_ctx, { kitId, name, colors, fonts, logoSvg, context, addScreens, removeScreens }) => {
      const kit = await ctx.runQuery(internal.brandKits.get, { ownerId: run.ownerId, kitId });
      if (!kit) throw new Error('Brand kit not found. List kits with listBrandKits.');
      const manual = fonts ? await googleFonts(ctx, fonts) : undefined;
      if (manual && !manual.fonts.length) throw new Error(`Not found on Google Fonts: ${manual.missing.join(', ')}.`);
      if (logoSvg !== undefined && !logoSvg.trim().startsWith('<svg')) throw new Error('logoSvg must be SVG markup.');
      let screens: { name: string; storageId: Id<'_storage'>; width?: number; height?: number; note?: string }[] | undefined;
      if (addScreens?.length || removeScreens?.length) {
        const added = await Promise.all((addScreens ?? []).map(async item => {
          const asset = assets.find(entry => entry._id === item.assetId);
          if (!asset || asset.kind !== 'image') throw new Error(`${item.assetId} is not an image in this project.`);
          const url = await mediaUrl(ctx, asset);
          const response = url ? await fetch(url) : null;
          if (!response?.ok) throw new Error(`Could not read ${asset.fileName}.`);
          const blob = await response.blob();
          if (blob.size > BRAND_LIMITS.screenBytes) throw new Error(`${asset.fileName} is over 8 MB; use a smaller screenshot.`);
          return { name: item.name, storageId: await ctx.storage.store(blob), ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}), ...(item.note ? { note: item.note } : {}) };
        }));
        const replaced = new Set([...(removeScreens ?? []), ...added.map(screen => screen.name)]);
        screens = [...(kit.screens ?? []).filter(screen => !replaced.has(screen.name)), ...added];
        if (screens.length > BRAND_LIMITS.screens) throw new Error(`A kit holds up to ${BRAND_LIMITS.screens} screens; remove one first.`);
      }
      await ctx.runMutation(internal.brandKits.update, { ownerId: run.ownerId, kitId: kit._id, ...(name ? { name } : {}), ...(colors ? { colors: cleanColors(colors) } : {}), ...(manual ? { fonts: manual.fonts } : {}), ...(logoSvg ? { logo: logoSvg.trim() } : {}), ...(context ? { context } : {}), ...(screens ? { screens } : {}) });
      return { updated: true, kitId, notes: manual?.missing.length ? [`Not found on Google Fonts: ${manual.missing.join(', ')}.`] : [] };
    } }),
    generateSound: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.generateSound, description: "The default way to add any sound effect: describe it in words and ElevenLabs generates it as real sound design, then it is placed on a free A layer at timeline seconds at (frame-snapped), starting on its first audible sample; save immediately. Time it exactly to the motion: a whoosh as long as a slide-in (duration), a pop per card, a riser into a hit. When the user gives a time, use exactly that time. Also call it, unasked, after addScene or a choreography-changing editScene: one sound per beat that needs one. gain is the clip volume 0..2 (default 0.7); sounds peak at -3 dBFS. If generation fails nothing is placed: say so, never substitute another sound. Returns the clip, its duration and any audible non-effect audio it overlaps.", inputSchema: soundEffectInput.extend({ at: z.number().min(0), gain: z.number().min(0).max(2).optional(), name: z.string().trim().min(1).max(60).optional() }), execute: async (_ctx, { at, gain = .7, name, ...request }) => {
      const asset = await createGeneratedSound(request, name);
      return { ...await placeEffectSound(asset._id, asset.duration!, at, gain), name: asset.fileName, duration: asset.duration };
    } }),
    listVoices: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.listVoices, description: "The narration voices generateVoice can speak with, each with what it sounds like. With sampleText, also speaks that line in each chosen voice (voiceIds, 2 to 6) and returns a playable sample URL per voice: offer them with askUser, one option per voice with its sample as audio, so the user hears the script's own first line before choosing. Samples are not placed on the timeline.", inputSchema: z.object({ sampleText: z.string().trim().min(3).max(VOICE_LIMITS.sample).optional(), voiceIds: z.array(z.string().trim().min(10).max(40)).min(1).max(6).optional().describe('Which voices to sample; voices from the list, or any ElevenLabs voice ID the user names.'), speed: voiceInput.shape.speed }).strict(), execute: async (_ctx, { sampleText, voiceIds, speed }) => {
      if (!sampleText) return { voices: NARRATION_VOICES };
      if (!voiceIds?.length) throw new Error('Choose the voiceIds to sample (2 to 6).');
      // One at a time: the ElevenLabs account allows only a few concurrent requests, shared with every other session.
      const samples = [];
      for (const voiceId of voiceIds) {
        const known = NARRATION_VOICES.find(voice => voice.voiceId === voiceId);
        samples.push({ voiceId, name: known?.name ?? voiceId, ...(known ? { description: known.description } : {}), sample: await publishPreview(await generateVoiceSample(voiceId, sampleText, { speed }, abortSignal, reserveAudio), 'audio/mpeg') });
      }
      return { sampleText, samples };
    } }),
    generateVoice: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.generateVoice, description: "Speak a narration script with an ElevenLabs voice (listVoices) and place it as one voice clip on a free A layer at timeline seconds at (frame-snapped); save immediately. The words are saved as the clip's transcript (inspectAssetAnalysis, addSubtitlesFromTranscript). Returns its duration and every word's timeline start and end: time the film's beats to these, so each visual lands on its spoken word. Write the script exactly as it should be read. To change the wording or voice, delete the clip and generate again. If generation fails nothing is placed: say so.", inputSchema: voiceInput.extend({ at: z.number().min(0), gain: z.number().min(0).max(2).optional().describe('Clip volume 0..2, default 1.'), name: z.string().trim().min(1).max(60).optional() }).strict(), execute: async (_ctx, { at, gain = 1, name, ...request }) => {
      const { samples, rate, words } = await generateNarration(request, abortSignal, reserveAudio), duration = samples[0].length / rate;
      const voice = NARRATION_VOICES.find(item => item.voiceId === request.voiceId)?.name, key = newProjectMediaKey(run.ownerId, run.projectId);
      const size = await putMediaObject(key, encodeWav(samples, rate), 'audio/wav');
      let asset: (typeof assets)[number];
      try {
        asset = await ctx.runMutation(internal.assistant.saveGeneratedSound, { ...run, r2Key: key, fileName: `${(name ?? `Narration${voice ? ` (${voice})` : ''}`).replace(/[\\/:*?"<>|]/g, '')}.wav`, size, duration, waveform: soundWaveform(samples, rate), transcript: { ...transcriptFromWords(words, duration), version: TRANSCRIPT_VERSION } });
        assets.push(asset);
      } catch (error) { await storageControl({ action: 'delete', key }).catch(() => {}); throw error; }
      const id = crypto.randomUUID();
      let start = at;
      const result = await checkpoint(t => {
        start = Math.round(at * t.fps) / t.fps;
        const placed = addMediaClip(t, { _id: asset._id, kind: 'audio', duration }, id, start, 1);
        return patchClip(placed, id, { volume: gain, ...audioSettingsPatch(find(placed, id), { role: 'voice' }) });
      });
      return { ...result, clipId: id, assetId: asset._id, name: asset.fileName, start, duration, end: start + duration, words: words.map(word => ({ text: word.text, start: Math.round((start + word.start) * 1000) / 1000, end: Math.round((start + word.end) * 1000) / 1000 })) };
    } }),
    editSound: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.editSound, description: "Regenerate a generated sound clip from a new prompt (and duration), keeping its start, layer and volume (it moves up a layer only if the new length would overlap). inspectClip shows the current prompt. Library and uploaded audio cannot be regenerated; delete and replace them.", inputSchema: soundEffectInput.extend({ clipId: z.string(), name: z.string().trim().min(1).max(60).optional() }), execute: async (_ctx, { clipId, name, ...request }) => {
      await editSession.wait();
      const current = find(editSession.timeline, clipId);
      const previous = assets.find(item => item._id === current.assetId);
      if (current.kind !== 'audio' || !previous?.soundRecipe) throw new Error('Choose a generated sound clip; library and uploaded audio cannot be regenerated.');
      const asset = await createGeneratedSound(request, name ?? previous.fileName.replace(/\.wav$/, ''));
      const result = await checkpoint(t => { const clip = find(t, clipId); return placeOnFreeLayer(t, { ...clip, assetId: asset._id, sourceStart: 0, duration: asset.duration! }); });
      return { ...result, clipId, name: asset.fileName, duration: asset.duration };
    } }),
    addLayer: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addLayer, description: "Add an empty effects-only FX track (up to 24), shared visual V track (up to 24), or audio A track (up to 12). Only effect clips belong to FX tracks. Video, images, captions and graphics share V tracks.", inputSchema: z.object({ group: z.enum(["effects", "visual", "audio"]) }), execute: async (_ctx, input) => checkpoint(t => { const tracks = deriveTrackCounts(t); const maximum = maxTrackCount(input.group); if (tracks[input.group] >= maximum) throw new Error(`This group already has ${maximum} tracks`); return { ...t, tracks: { ...tracks, [input.group]: tracks[input.group] + 1 } }; }) }),
    deleteEmptyLayer: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.deleteEmptyLayer, description: "Delete one EMPTY FX, V or A track without deleting clips. group effects means FX, visual means V, audio means A; track is its current number. Refuses occupied tracks. Higher tracks are renumbered while timing, stacking order, media and linked audio remain intact. Inspect current track numbers again after deletion if needed. Saves immediately.", inputSchema: z.object({ group: z.enum(['effects', 'visual', 'audio']), track: z.number().int().min(1).max(24) }), execute: async (_ctx, input) => checkpoint(t => deleteEmptyLayer(t, input.group, input.track)) }),
    removeEmptyLayers: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.removeEmptyLayers, description: "When the user asks to clean up ALL empty tracks, remove every empty effects/visual/audio track in one saved change. Never deletes clips, changes timing or alters stacking order; occupied FX/V/A tracks become contiguous within their own group.", inputSchema: z.object({}), execute: async () => checkpoint(removeEmptyLayers) }),
    configureSmoothZoom:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureSmoothZoom,description:"Add one smooth zoom-in, optional hold and return on a video/image. start uses TIMELINE seconds; inDuration/holdDuration/outDuration use timeline seconds, independent of playback speed. outDuration:0 holds the zoom through the clip end. scale1..10, easing linear/ease-in-out/ease-out/focused-spring. focused-spring gives a snappy, smoothly settling zoom without bounce; choose it for requested focused or spring-style camera zooms. ease-out starts fast and brakes smoothly. focus center is only for a generic centered zoom. For a named modal, cursor or object, first inspectFrames at a relevant source instant and use its targetId; current-request evidence must match this retained source and zoom window. focus coordinates is only for coordinates explicitly given by the user, in original displayed SOURCE pixels or normalized0..1, never preview-screen pixels. Existing crop/fit maps the target automatically. framing center moves the target toward the canvas center; source-edge limits prevent revealing empty space, so edge targets may remain off-center. anchor keeps it at its existing screen position. Named targets default to center, generic and explicit coordinate focus default to anchor. A nonzero outDuration restores the pre-zoom framing. Do not use static crop or transform changes to simulate a temporary close-up that must return. Preserve linked audio, source trim and static transform. Custom motion requires explicit replaceMotion:true authorization. One validated operation stores canonical motion for preview/export; no per-frame tool calls.",inputSchema:z.object({clipId:z.string().min(1),start:z.number().min(0),inDuration:z.number().positive(),holdDuration:z.number().min(0),outDuration:z.number().min(0),scale:z.number().min(CAMERA_ZOOM_RANGE[0]).max(CAMERA_ZOOM_RANGE[1]),easing:z.enum(SMOOTH_ZOOM_EASINGS),framing:z.enum(['anchor','center']).optional(),replaceMotion:z.boolean().optional(),focus:z.union([z.object({kind:z.literal('center')}).strict(),z.object({kind:z.literal('target'),targetId:z.string().min(1)}).strict(),z.object({kind:z.literal('coordinates'),centerX:z.number(),centerY:z.number(),units:z.enum(VISUAL_INPUT_UNITS).optional()}).strict()])}),execute:async(_ctx,{clipId,focus,...input})=>checkpoint(t=>{
      const clip=find(t,clipId),asset=assets.find(item=>item._id===clip.assetId);
      if(!asset)throw new Error('Choose media from this project.');
      return patchClip(t,clipId,configureSmoothZoomPatch(clip,{...asset,url:null},t.aspectRatio,input,focus,zoomTargets));
    })}),
    configureCameraMotion:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureCameraMotion,description:"Configure one clip-level camera path for uploaded video/image: zoom, pan/glide, or sampled object/cursor following. Send 2–8 keyframes together in one call, each with TIMELINE time, scale1..10, focus and easing. The destination keyframe easing controls movement into that point. Same scale with changing focus glides; repeated focus/scale holds; the last point holds until clip end. To return wide, include an explicit final scale1 point with the original view center; inspect static framing rather than assuming a cropped/off-center clip has a .5,.5 original view center. The camera moves each source focus toward the center through existing fit/crop/static placement, clamping to the retained source window so it never creates empty edge space. Near an edge the target can remain off-center; do not force exact centering by moving the static clip. Preserve base transform, media trims, speed and linked audio. mode glide means a planned route across static targets. mode follow means sampled movement: inspectFrames at distinct requested SOURCE instants, pass each returned current-request targetId at its matching TIMELINE instant, within one source frame. Do not reuse an old cursor position as a later tracked position or claim continuous tracking between sparse samples. For a named object first inspectFrames; never invent coordinates. Explicit coordinates are only for original-source coordinates provided by the user. Generic center needs no analysis. Existing camera paths/smooth zoom can be replaced; arbitrary custom motion requires explicit user authorization and replaceMotion:true. This affects one footage clip, not text/other layers or the whole scene. Optional blurAmount0..1 adds speed-driven directional blur during camera gliding, default off;0disables. Blur clears on holds/stopped preview and preserves static directionalBlur. No per-frame tool calls.",inputSchema:z.object({clipId:z.string().min(1),mode:z.enum(['glide','follow']).optional(),blurAmount:z.number().min(0).max(1).optional(),replaceMotion:z.boolean().optional(),keyframes:z.array(z.object({time:z.number().min(0),scale:z.number().min(CAMERA_ZOOM_RANGE[0]).max(CAMERA_ZOOM_RANGE[1]),easing:z.enum(SMOOTH_ZOOM_EASINGS),focus:z.union([z.object({kind:z.literal('center')}).strict(),z.object({kind:z.literal('target'),targetId:z.string().min(1)}).strict(),z.object({kind:z.literal('coordinates'),centerX:z.number(),centerY:z.number(),units:z.enum(VISUAL_INPUT_UNITS).optional()}).strict()])}).strict()).min(2).max(8)}).strict(),execute:async(_ctx,{clipId,...input})=>checkpoint(t=>{
      const clip=find(t,clipId),asset=assets.find(item=>item._id===clip.assetId);
      if(!asset)throw new Error('Choose media from this project.');
      return patchClip(t,clipId,configureCameraMotionPatch(clip,{...asset,url:null},t.aspectRatio,input,zoomTargets));
    })}),
    transformClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.transformClip, description: "Set one video/image's static position, scale, rotation or opacity with clipId, OR apply the same requested patch to exact clipIds in one atomic save. Prefer clipIds for the same framing across several clips; never send both target fields. units defaults normalized: center x/y -5..5; 0..1 spans the canvas and off-frame positions are allowed. units pixels uses the canvas reference with shorter dimension1080 (landscape1920×1080, vertical1080×1920), independent of export resolution. Scale0.1..5, rotation degrees±360, opacity0..1. Preserve omitted controls, linked sound and retained source/timing. Reject unknown pixel geometry and invalid/nonvisual targets without saving a partial batch.", inputSchema:z.object({clipId:z.string().min(1).optional(),clipIds:z.array(z.string().min(1)).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,{message:'Choose unique clip IDs.'}).optional(),...transformFields}).strict().refine(input=>(input.clipId!==undefined)!==(input.clipIds!==undefined),{message:'Choose clipId or clipIds, never both.'}),execute:async(_ctx,input)=>checkpoint(t=>{
      const ids=input.clipIds??[input.clipId!];
      const {units,x,y,scale,rotation,opacity}=input,changes={x,y,scale,rotation,opacity};
      let next=t;
      for(const id of ids)next=patchClip(next,id,transformInputPatch(find(next,id),changes,dimensions(t.aspectRatio),units));
      return next;
    }) }),
    configureVisualFade:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureVisualFade,description:"Set an explicitly requested fade in/out on one video or image clip; also builds a crossfade when the incoming clip overlaps the outgoing one. Apply it directly, without planEffects or previewRender. Fade values are timeline seconds; their total must fit the retained clip duration. Use 0 to remove a requested edge fade. Preserve omitted edge controls, static opacity, crop/motion, source range, clip timing, linked audio/gain/fades and every other clip. Explicit fade edits restart this clip's fade phase; later trims/splits retain it. Saves immediately.",inputSchema:z.object({clipId:z.string(),fadeIn:z.number().min(0).max(VISUAL_FADE_MAX_SECONDS).optional(),fadeOut:z.number().min(0).max(VISUAL_FADE_MAX_SECONDS).optional()}).refine(input=>input.fadeIn!==undefined||input.fadeOut!==undefined,{message:'Specify a visual fade in or out.'}),execute:async(_ctx,{clipId,...changes})=>checkpoint(t=>configureVisualFade(t,clipId,changes))}),
    animateEffect: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.animateEffect, description: "Keyframe one numeric visual-effect control over time on a VIDEO or IMAGE clip, e.g. a grade that drains colour on a line (colorGrade.saturation 1 to 0.3), a blur-in reveal (softBlur.amount 20 to 0), a light leak that flares on a beat (lightLeak.amount), glitch that ramps up (glitch.intensity), heat haze (turbulentDisplace.amount), lens distortion with chromatic fringing (lensDistortion.amount / .fringing), film or VHS strength, light sweeps, zoom blur, frame bend. control is group.control from the effect controls list (same ranges as setVisualEffects). keyframes use CLIP-LOCAL seconds and absolute values; 1 to 9 anchors, each with optional easing (named, or a cubic-bézier [x1,y1,x2,y2]); values hold before the first and after the last anchor. The animated group is switched on while keyframed and its other controls keep their current or default values, so set those first with setVisualEffects when they matter. Replaces this control's previous keyframes; clear:true removes them. Saves immediately.", inputSchema: z.object({ clipId: z.string().min(1), control: z.enum(EFFECT_KEYFRAME_CONTROLS as [string, ...string[]]), keyframes: z.array(z.object({ time: z.number().min(0), value: z.number(), easing: motionEasingInput.optional() }).strict()).max(9).optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId);
      if (!input.clear && !input.keyframes?.length) throw new Error('Give 1 to 9 keyframes, or clear:true to remove this control\'s keyframes.');
      return patchClip(t, clip.id, effectKeyframesPatch(clip, input.control, input.clear ? null : input.keyframes!));
    }) }),
    setMask: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setMask, description: "Mask a VIDEO or IMAGE clip so only a shape shows (or, with invert, everything except it): rectangle (optional corner radius 0..0.5), ellipse, polygon (3–64 points [x,y] within 0..1 of its box, for freehand shapes) or text (1–40 characters filling its box; the footage shows through the letters). Geometry is canvas fractions of the clip's frame: x/y center, width/height, rotation degrees, feather = soft edge in px at 1080p (0 hard, 20–60 soft). keyframes: 1–9 anchors in CLIP-LOCAL seconds with optional easing (named or cubic-bézier); e.g. a box that grows from the center, an oval vignette that tightens on a punchline, a diagonal wipe, text that reveals B-roll. Use invert with a blurred copy above the footage to blur everything but one area. Replaces this clip's mask; clear:true removes it. Saves immediately.", inputSchema: z.object({ clipId: z.string().min(1), shape: z.enum(MASK_SHAPES).optional(), invert: z.boolean().optional(), radius: z.number().min(0).max(.5).optional(), points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).max(64).optional(), text: z.string().min(1).max(40).optional(), keyframes: z.array(z.object({ time: z.number().min(0), x: z.number().min(-1).max(2), y: z.number().min(-1).max(2), width: z.number().min(.005).max(4), height: z.number().min(.005).max(4), rotation: z.number().min(-360).max(360).optional(), feather: z.number().min(0).max(200).optional(), easing: motionEasingInput.optional() }).strict()).min(1).max(9).optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId);
      const tracking = clip.pixelTracking?.mode === 'mask' ? { pixelTracking: undefined } : {};
      if (input.clear) return patchClip(t, clip.id, { ...tracking, mask: undefined });
      if (!input.shape || !input.keyframes?.length) throw new Error('Give a shape and 1 to 9 keyframes, or clear:true.');
      if (input.keyframes.some(key => key.time > clip.duration + 1e-6)) throw new Error('Mask keyframes must fit inside the clip, in clip-local seconds.');
      const keys = bakeMaskAnchors(input.keyframes.map(key => ({ ...key, rotation: key.rotation ?? 0, feather: key.feather ?? 0 })), clip.motionOffset ?? 0);
      return patchClip(t, clip.id, { ...tracking, mask: { shape: input.shape, ...(input.invert ? { invert: true } : {}), ...(input.radius !== undefined ? { radius: input.radius } : {}), ...(input.points ? { points: input.points } : {}), ...(input.text ? { text: input.text } : {}), keys } });
    }) }),
    trackPoints: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.trackPoints, description: "Start durable pixel tracking forward AND backward from one TIMELINE seed time, including moving cameras and gameplay. seed: {kind:'point',x,y}, {kind:'box',box:{left,top,right,bottom}} in normalized SOURCE coordinates, {kind:'target',targetId} from inspectFrames, or {kind:'object',noun:'red crate'} localized from one source frame in the processor: MCP clients get SAM 3.1 on Meta's Model API (MODEL_API_KEY on the worker; exactly one match or a clear failure, no fallback), Revline's in-app agent gets Florence-2 on fal (FAL_KEY). Explicit point/box seeds and existing inspectFrames targets skip paid grounding; use readFrames to choose a box without Gemini. Detector boxes need visual verification. Optional start/end are TIMELINE bounds, default whole clip. There is no duration or frame-count limit: the processor streams dense chunks across the requested range, re-acquiring a distinctive target after loss. Zero-confidence samples hide attached overlays and masks during missing evidence. A confirmed cut ends that direction. Returns trackId immediately; getTrack reads progress and every dense sample page. attachToTrack can reference it while processing and begins following automatically when ready. No timeline changes and no invented motion through occlusion.", inputSchema: trackInput, execute: async (_ctx, input) => reportAnalysisFailure(async () => { const reference = await measurePixelTrack(input); return { trackId: reference.trackId, status: 'queued', note: 'Tracking continues in the background. Use getTrack for status and dense pages, or attachToTrack now.' }; }) }),
    getTrack: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getTrack, description: "Read a pixel track's durable status, confidence and stop reasons. Completed tracks return a dense page of SOURCE-time samples and, for a noun seed, summary.grounding with the detector-proposed box/provider/time. Inspect that box in a source frame; detection is not verified identity and can guess when an object is absent. Pass nextCursor as cursor to read successive pages without dropping frames, or time (SOURCE seconds) to read a local window with smoothing neighbors. No duration/frame cap and no timeline changes.", inputSchema: z.object({ trackId: z.string().min(1), cursor: z.number().nonnegative().optional(), time: z.number().nonnegative().optional() }).strict(), execute: async (_ctx, input) => ctx.runQuery(internal.pixelTracks.pageForRun, { ...run, ...input }) }),
    attachToTrack: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.attachToTrack, description: "Attach text, image, graphic/hit marker, solid/glow or video to tracked pixels on moving-camera footage. target {trackId} reuses trackPoints; or {time,seed,start?,end?} starts it in the background, with TIMELINE seconds and the same point/box/targetId/noun seed. target 'subject' preserves face tracking, and legacy {points} remains supported. mode move follows the center plus offsetX/offsetY canvas fractions and hides the overlay outside the visible tracked range. Box tracks also follow scale/rotation unless followTransform:false. smoothing 0..1 defaults .35, a symmetric jitter filter. mode mask needs mask:{shape,width,height}; it animates its center/size/rotation on the footage or a synchronized copy. Saves a compact tracking reference immediately; following starts automatically once its background job finishes. Preview and export stream nearby dense samples, without embedding the whole shot in the timeline.", inputSchema: z.object({ clipId: z.string().min(1), footageClipId: z.string().min(1), target: z.union([z.literal('subject'), z.object({ points: z.array(z.object({ time: z.number().min(0), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict()).min(2) }).strict(), z.object({ trackId: z.string().min(1) }).strict(), trackInput.omit({ footageClipId: true })]), mode: z.enum(['move', 'mask']).optional(), smoothing: z.number().min(0).max(1).optional(), followTransform: z.boolean().optional(), offsetX: z.number().min(-1).max(1).optional(), offsetY: z.number().min(-1).max(1).optional(), mask: z.object({ shape: z.enum(MASK_SHAPES), width: z.number().min(.005).max(4), height: z.number().min(.005).max(4), feather: z.number().min(0).max(200).optional(), invert: z.boolean().optional(), radius: z.number().min(0).max(.5).optional(), text: z.string().min(1).max(40).optional() }).strict().optional() }).strict(), execute: async (_ctx, input) => {
      await editSession.wait();
      const selected = find(editSession.timeline, input.footageClipId), source = selected.assetId ? await loadAsset(selected.assetId) : undefined;
      if (!source) throw new Error('Choose an uploaded footage clip to track.');
      if (input.target === 'subject' && !source.analysis?.focus?.length) await analyze(source._id, 'track');
      const pixelTrack = input.target !== 'subject' && 'trackId' in input.target ? await readPixelTrack(input.target.trackId, selected) : input.target !== 'subject' && 'seed' in input.target ? await measurePixelTrack({ ...input.target, footageClipId: input.footageClipId }) : undefined;
      return checkpoint(t => {
        const footage = find(t, input.footageClipId), clip = find(t, input.clipId), asset = assets.find(item => item._id === footage.assetId);
        if (footage.assetId !== selected.assetId) throw new Error('The source changed during tracking. Track the new footage before attaching.');
        if (!asset) throw new Error('The footage media is unavailable.');
        if (pixelTrack) return patchClip(t, clip.id, streamedAttachmentPatch(clip, footage, asset, t.aspectRatio, pixelTrack, { mode: input.mode ?? 'move', offsetX: input.offsetX, offsetY: input.offsetY, smoothing: input.smoothing, followTransform: input.followTransform, mask: input.mask }));
        const samples = input.target === 'subject' ? asset.analysis?.focus ?? [] : 'points' in input.target ? pointsToSamples(footage, input.target.points) : [];
        if (!samples.length) throw new Error('No moving subject was detected in this footage. Give points from inspectFrames instead.');
        if ((input.mode ?? 'move') === 'mask') {
          if (!input.mask) throw new Error('Mask mode needs mask: {shape, width, height}.');
          return patchClip(t, clip.id, attachMaskPatch(clip, footage, asset, t.aspectRatio, samples, input.mask, { smoothing: input.smoothing, followTransform: input.followTransform, fps: t.fps }));
        }
        return patchClip(t, clip.id, attachOverlayPatch(clip, footage, asset, t.aspectRatio, samples, { x: input.offsetX ?? 0, y: input.offsetY ?? 0 }, { smoothing: input.smoothing, followTransform: input.followTransform, fps: t.fps }));
      });

    } }),
    setMotionBlur: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setMotionBlur, description: "Set motion blur on keyframed movement (animateClip paths on video, image, text or solid clips; camera paths keep their own blurAmount). amount 0..1 (0 off; .5 natural; 1 strong). This blurs keyframed transforms, not the pixel motion from a speed ramp alone; use zoomBlur or directionalBlur for a timed footage rush. Slides and pans get directional blur along the motion, scale pops and punch-ins get radial blur, both scaled by speed so held frames stay sharp. Use for premium-feeling pop-ins, slides and whip moves. Saves immediately.", inputSchema: z.object({ clipIds: clipIdsInput, amount: z.number().min(0).max(1) }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      let next = t;
      for (const id of input.clipIds) {
        const clip = find(next, id);
        if (input.amount > 0 && !clip.motion?.length) throw new Error(`Clip ${id} has no keyframed movement; animate it first with animateClip.`);
        next = patchClip(next, id, { motionBlur: input.amount > 0 ? input.amount : undefined });
      }
      return next;
    }) }),
    setVisualEffects: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setVisualEffects, description: "For an explicit effect request or authorized creative styling (AMV/hype/cinematic): adjust an uploaded video/image's requested controls with clipId, or apply the SAME patch to exact clipIds in ONE atomic save. Prefer batch clipIds for identical colors, corner rounding or effects across several sources; never send both target fields. All target validation precedes saving. Adjust these controls. Preserve all omitted controls and unrelated clips. Set enabled:true to activate a group, enabled:false to bypass it while retaining settings. Exposure is stops (-2..2), contrast/saturation 1 is neutral, temperature/tint/vibrance 0 is neutral. Blur amount/intensity are 0..1; centerX/Y are normalized. Glitch blockSize/RGB split are pixels at 1080 output height. Invert amount 1 gives negative colors, 0 is unchanged. frameCorners is the independent clip-setting Corner rounding: amount 0..1 changes the corner radius from square to fully rounded. softBlur is the clip-wide Blur setting: amount is 0..40 design pixels, 0 is clear. Combine with transform opacity for a translucent blurred background layer. Film overlay provides procedural grain, dust, scratches, vignette, flicker and warmth, each 0..1 with an overall amount; it uses no generated footage. Turbulent displace warps footage with procedural turbulence: amount 0..100 design pixels, scale 10..600 design pixels controls the noise feature size, speed 0..3 controls evolution (0 holds it still). VHS adds analog tape scanlines, noise, RGB bleed and tracking, each 0..1 with overall amount 0..1; speed 0..3 controls temporal movement and 0 freezes it. Bloom makes highlights glow: amount 0..2 (.3 subtle, .6 visible, 1.2 dreamy), threshold 0..0.95 (brightness where glow starts, .65 typical), radius 2..80 design pixels. These textures affect this uploaded video/image only, with no generated footage; disabled or amount 0 is visually neutral. zoomBlur provides radial amount 0..1 and centerX/Y 0..1. lensDistortion amount -.8.. .8 warps the lens; fringing 0..10 adds chromatic lens fringing in reference pixels (set amount:0 for fringing alone). Footage controls apply throughout this clip. For creative styling, use inspected action and the shared style playbook to choose restrained, purposeful effects. Saves immediately.", inputSchema: z.object({ clipId: z.string().min(1).optional(),clipIds:z.array(z.string().min(1)).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,{message:'Choose unique clip IDs.'}).optional(), zoomBlur:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(1).optional(),centerX:z.number().min(0).max(1).optional(),centerY:z.number().min(0).max(1).optional()}).strict().optional(), lensDistortion:z.object({enabled:z.boolean().optional(),amount:z.number().min(-.8).max(.8).optional(),centerX:z.number().min(0).max(1).optional(),centerY:z.number().min(0).max(1).optional(),fringing:z.number().min(0).max(10).optional()}).strict().optional(), frameCorners:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(1).optional()}).optional(), softBlur:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(40).optional()}).optional(), bloom:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(2).optional(),threshold:z.number().min(0).max(.95).optional(),radius:z.number().min(2).max(80).optional()}).optional(), filmOverlay:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(1).optional(),grain:z.number().min(0).max(1).optional(),dust:z.number().min(0).max(1).optional(),scratches:z.number().min(0).max(1).optional(),vignette:z.number().min(0).max(1).optional(),flicker:z.number().min(0).max(1).optional(),warmth:z.number().min(0).max(1).optional()}).optional(), turbulentDisplace:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(100).optional(),scale:z.number().min(10).max(600).optional(),speed:z.number().min(0).max(3).optional()}).optional(), vhs:z.object({enabled:z.boolean().optional(),amount:z.number().min(0).max(1).optional(),scanlines:z.number().min(0).max(1).optional(),noise:z.number().min(0).max(1).optional(),bleed:z.number().min(0).max(1).optional(),tracking:z.number().min(0).max(1).optional(),speed:z.number().min(0).max(3).optional()}).optional(), invert: z.object({ enabled: z.boolean().optional(), amount: z.number().min(0).max(1).optional() }).optional(), colorGrade: z.object({ enabled: z.boolean().optional(), exposure: z.number().min(VISUAL_EFFECT_LIMITS.colorGrade.exposure[0]).max(VISUAL_EFFECT_LIMITS.colorGrade.exposure[1]).optional(), contrast: z.number().min(0).max(2).optional(), saturation: z.number().min(0).max(2).optional(), temperature: z.number().min(-100).max(100).optional(), tint: z.number().min(-100).max(100).optional(), vibrance: z.number().min(-100).max(100).optional() }).optional(), glitch: z.object({ enabled: z.boolean().optional(), intensity: z.number().min(0).max(1).optional(), blockSize: z.number().min(1).max(100).optional(), rgbSplit: z.number().min(0).max(50).optional() }).optional() }).strict().refine(input=>(input.clipId!==undefined)!==(input.clipIds!==undefined),{message:'Choose clipId or clipIds, never both.'}), execute: async (_ctx, { clipId,clipIds, ...changes }) => checkpoint(t => {
      let next=t;
      for(const id of clipIds??[clipId!])next=patchClip(next,id,visualEffectsPatch(find(next,id),changes));
      return next;
    }) }),
    setSpeedRamp: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setSpeedRamp, description: "Speed-ramp one video or audio clip (its linked partner follows): the same source footage plays, but speed changes over the clip, and the clip's length becomes source length / average speed (it can grow, so leave room after it). Presets: montage (slow-fast-slow), hero (fast, slow-mo hit, fast), bullet (fast, near-freeze at the middle, fast), flash-in (slow then whips in), flash-out (whips then slows), ramp-in (half speed easing to normal), ramp-out (normal easing to half), slowmo-middle (normal, slow-mo through the middle, normal). Or give 2–12 anchors {x: 0..1 fraction of the clip, rate: 0.1..10, easing?} for a custom curve; segments ease-in-out by default (named easing or cubic-bézier). Align the slow part with the moment that matters (inspect it first). clear:true restores normal speed. Rendered by the playback engine in preview and export; replaces any constant setPlaybackRate speed. Saves immediately.", inputSchema: z.object({ clipId: z.string().min(1), preset: z.enum(SPEED_RAMP_PRESET_IDS as [SpeedRampPreset, ...SpeedRampPreset[]]).optional(), anchors: z.array(z.object({ x: z.number().min(0).max(1), rate: z.number().min(.1).max(10), easing: motionEasingInput.optional() }).strict()).min(2).max(12).optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId);
      if ([input.preset, input.anchors, input.clear || undefined].filter(value => value !== undefined).length !== 1) throw new Error('Give exactly one of preset, anchors or clear:true.');
      return setClipSpeedRamp(t, clip.id, input.clear ? null : input.preset ? presetAnchors(input.preset) : input.anchors!);
    }) }),
    analyzeColor: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.analyzeColor, description: "Measure a video/image clip's real color from its source frames (not a guess from a description): exposure (median, shadows, highlights, contrast range), saturation, the light's color cast (warmth red-vs-blue, tint green-vs-magenta, from near-neutral midtones), dominant colors with names and shares, plain-language notes (e.g. warm orange cast, underexposed, clipped highlights) and a neutralizing suggestedGrade for setVisualEffects colorGrade. Optional times are timeline seconds inside the clip (1-4; default three across it). Use before color correcting, to explain a look, or to plan a grade that keeps or removes orange tungsten light.", inputSchema: z.object({ clipId: z.string().min(1), times: z.array(z.number().min(0)).min(1).max(4).optional() }).strict(), execute: async (_ctx, input) => reportAnalysisFailure(async () => {
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId), stats = await measureClip(clip, input.times);
      return { clipId: clip.id, measuredAt: stats.map(item => item.time), ...describeColor(stats), note: 'Measured on the source footage, before this clip\'s grade and effects.' };
    }) }),
    matchColor: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.matchColor, description: "Shot matching: make clips look like a reference clip by measuring both (three frames each) and setting per-channel RGB curves that map each clip's tones onto the reference's (histogram matching), fixing exposure, contrast and color cast between cameras or lighting. strength 0..1 (default 1; .6-.8 keeps some of the original). Matches source footage: the reference's own grade is not included, so match first, then apply one shared grade or LUT to all. Replaces the clips' red/green/blue curves (the master curve is kept).", inputSchema: z.object({ clipIds: clipIdsInput, referenceClipId: z.string().min(1), strength: z.number().min(0).max(1).optional() }).strict(), execute: async (_ctx, input) => reportAnalysisFailure(async () => {
      await editSession.wait();
      const reference = await measureClip(find(editSession.timeline, input.referenceClipId));
      const matched: Record<string, ReturnType<typeof matchCurves>> = {};
      for (const id of input.clipIds) { if (id === input.referenceClipId) continue; matched[id] = matchCurves(await measureClip(find(editSession.timeline, id)), reference, input.strength ?? 1); }
      const saved = await checkpoint(t => { let next = t; for (const [id, curves] of Object.entries(matched)) { const clip = find(next, id); next = patchClip(next, clip.id, { colorCurves: { ...(clip.colorCurves?.master ? { master: clip.colorCurves.master } : {}), ...curves } }); } return next; });
      return { ...saved, matched: Object.keys(matched), reference: describeColor(reference).notes };
    }) }),
    setColorCurves: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setColorCurves, description: "Set RGB and master tone curves on video/image clips (after the basic grade): each curve is 2-16 [input, output] points within 0..1, interpolated smoothly without overshoot. master shapes all channels (S-curve for contrast: [[0,0],[.25,.2],[.75,.82],[1,1]]; lifted blacks for a faded film look: [[0,.08],[1,1]]); red/green/blue shift color by tone (teal shadows: blue [[0,.08],[.5,.5],[1,1]]). Omitted curves are kept; clear:true removes all curves.", inputSchema: z.object({ clipIds: clipIdsInput, master: curveInput.optional(), red: curveInput.optional(), green: curveInput.optional(), blue: curveInput.optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, { clipIds, clear, ...curves }) => checkpoint(t => {
      let next = t;
      for (const id of clipIds) { const clip = find(next, id); next = patchClip(next, clip.id, { colorCurves: clear ? undefined : { ...clip.colorCurves, ...curves } }); }
      return next;
    }) }),
    setHSL: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setHSL, description: `Targeted color by hue band (HSL secondary): for each of ${HSL_BANDS.join(', ')} set hue shift (-60..60 degrees), saturation (-1..1, -1 removes that color) and luminance (-1..1). Bands blend smoothly into neighbors and grays are untouched. Examples: tame orange skin or tungsten light (orange saturation -.3), richer sky (blue saturation .3, luminance -.2), teal foliage (green hue 30), isolate red (every other band saturation -1). Given bands replace those bands; clear:true removes HSL.`, inputSchema: z.object({ clipIds: clipIdsInput, bands: z.object(Object.fromEntries(HSL_BANDS.map(band => [band, z.object({ hue: z.number().min(-60).max(60).optional(), saturation: z.number().min(-1).max(1).optional(), luminance: z.number().min(-1).max(1).optional() }).strict().optional()])) as Record<typeof HSL_BANDS[number], z.ZodOptional<z.ZodObject<{ hue: z.ZodOptional<z.ZodNumber>; saturation: z.ZodOptional<z.ZodNumber>; luminance: z.ZodOptional<z.ZodNumber> }, z.core.$strict>>>).strict().optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      if (!input.clear && !input.bands) throw new Error('Give bands, or clear:true.');
      let next = t;
      for (const id of input.clipIds) {
        const clip = find(next, id), hsl: HslAdjust = { ...clip.hsl };
        for (const [band, shift] of Object.entries(input.bands ?? {})) if (shift) hsl[band as keyof HslAdjust] = { hue: shift.hue ?? 0, saturation: shift.saturation ?? 0, luminance: shift.luminance ?? 0 };
        next = patchClip(next, clip.id, { hsl: input.clear ? undefined : hsl });
      }
      return next;
    }) }),
    applyLut: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyLut, description: `Apply a LUT look to video/image clips, blended by amount 0..1 (default 1; .5-.8 is often enough). Built-in looks: ${LUT_LOOKS.join(', ')}. Or pass cube: the full text of a .cube LUT file (e.g. a camera log-to-Rec709 conversion or a purchased film look) with a name; it is stored once on the timeline (up to ${MAX_TIMELINE_LUTS} custom LUTs) and reused by name. Applied after grade, curves and HSL. clear:true removes the LUT.`, inputSchema: z.object({ clipIds: clipIdsInput, look: z.string().min(1).max(60).optional().describe('A built-in look, or the name of a custom LUT already stored'), cube: z.string().min(20).max(3_000_000).optional(), name: z.string().min(1).max(60).optional(), amount: z.number().min(0).max(1).optional(), clear: z.boolean().optional() }).strict(), execute: async (_ctx, input) => checkpoint(t => {
      let next = t, look: string | undefined;
      if (input.cube) {
        const parsed = parseCube(input.cube), name = input.name ?? 'Custom LUT', existing = next.luts?.find(lut => lut.name === name);
        const id = existing?.id ?? crypto.randomUUID().slice(0, 8);
        const luts = [...(next.luts ?? []).filter(lut => lut.id !== id), { id, name, ...parsed }];
        if (luts.length > MAX_TIMELINE_LUTS) throw new Error(`A timeline keeps up to ${MAX_TIMELINE_LUTS} custom LUTs. Reuse one by name.`);
        next = { ...next, luts }; look = `custom:${id}`;
      } else if (input.look) {
        const custom = next.luts?.find(lut => lut.name === input.look || `custom:${lut.id}` === input.look);
        look = custom ? `custom:${custom.id}` : input.look;
      }
      if (!input.clear && !look) throw new Error('Give a look, a cube file, or clear:true.');
      for (const id of input.clipIds) { const clip = find(next, id); next = patchClip(next, clip.id, { lut: input.clear ? undefined : { look: look!, amount: input.amount ?? 1 } }); }
      // Drop custom LUTs no clip uses any more.
      const used = new Set(next.clips.flatMap(clip => clip.lut?.look.startsWith('custom:') ? [clip.lut.look.slice(7)] : []));
      return next.luts ? { ...next, luts: next.luts.filter(lut => used.has(lut.id)) } : next;
    }) }),
    addTransition: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addTransition, description: `Add a transition across the cut between two touching video/image clips on the same V layer (fromClipId ends exactly where toClipId starts). Presets: ${TRANSITION_PRESETS.map(preset => `${preset} (${EFFECT_CATALOG[preset].description})`).join(' ')} duration in seconds (whip-pan .13-.17, 4-5 frames at 30 fps, default .133; zoom-through .4-.6, a push (whip zooms are whip-pan with whipDirection zoom or zoom-out); film-burn .6-1; others about .6; durations snap to whole frames, at least 2), limited by the footage around the cut. direction applies to spin-zoom; wipeDirection to gradient-wipe (left/right/up/down); whip-pan takes whipDirection (left/right/up/down/zoom/zoom-out, default left), travel (share of the frame, .1-.25, default .15), frames (3-6 at 30 fps instead of duration, default 4) and blur (peak px at 1080p along the whip axis, 0-48, default 24, zooms 10, 0 off); centerX/centerY/shape/softness to iris and gradient wipes. Read the transitions skill first. Returns transitionClipId. Transitions cannot be split; moving or deleting a connected clip removes the transition when its cut disappears.`, inputSchema: z.object({ fromClipId: z.string().min(1), toClipId: z.string().min(1), preset: z.enum(TRANSITION_PRESETS), duration: z.number().min(.1).max(3).optional(), direction: z.enum(TRANSITION_DIRECTIONS).optional(), wipeDirection: z.enum(WIPE_DIRECTIONS).optional(), whipDirection: z.enum(WHIP_DIRECTIONS).optional(), travel: z.number().min(WHIP_TRAVEL.min).max(WHIP_TRAVEL.max).optional(), frames: z.number().int().min(WHIP_FRAMES.min).max(WHIP_FRAMES.max).optional(), blur: z.number().min(0).max(WHIP_BLUR_MAX).optional(), softness: z.number().min(0).max(1).optional(), centerX: z.number().min(0).max(1).optional(), centerY: z.number().min(0).max(1).optional(), shape: z.enum(IRIS_SHAPES).optional() }).strict().refine(input => input.preset === 'whip-pan' || (input.whipDirection === undefined && input.travel === undefined && input.frames === undefined && input.blur === undefined), { message: 'whipDirection, travel, frames and blur belong to whip-pan.' }).refine(input => input.frames === undefined || input.duration === undefined, { message: 'Give frames or duration, not both.' }), execute: async (_ctx, { fromClipId, toClipId, preset, frames, ...options }) => {
      if (frames !== undefined) options.duration = frames / 30;
      const transitionClipId = crypto.randomUUID();
      const saved = await checkpoint(t => addTransitionClip(t, transitionClipId, preset, fromClipId, toClipId, options));
      return { ...saved, transitionClipId };
    } }),
    addImpactFrame: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addImpactFrame, description: "Add a frame-exact hit look at TIMELINE time at. Give exactly one of frames (whole project frames) or duration (seconds, snapped to the frame grid), from one frame to 30 seconds. Presets invert, black-white, posterize, manga. Optional intensity, threshold, levels, radial speedLines, flash and centerX/Y. Applies to footage on all V layers during this range; no source/audio retiming. Returns effectClipId. Read vfx for montage timing.", inputSchema: impactSettingsSchema.partial().extend({ at:z.number().min(0), frames:z.number().int().positive().optional(), duration:z.number().positive().max(30).optional() }).strict(), execute:async(_ctx,{at,frames,duration,...settings})=>{
      const effectClipId=crypto.randomUUID();
      const saved=await checkpoint(t=>patchClip(addEffectClip(t,effectClipId,'impact-frame',at,{duration:vfxDuration(t.fps,frames,duration)}),effectClipId,{impact:{...DEFAULT_IMPACT,...settings}}));
      return {...saved,effectClipId};
    }}),
    configureImpactFrame: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureImpactFrame, description:"Adjust an existing impact-frame FX. Omitted settings and timing stay intact. frames or duration changes its length; use moveClips to change its timeline time. Delete the FX to remove it.",inputSchema:impactSettingsSchema.partial().extend({clipId:z.string().min(1),frames:z.number().int().positive().optional(),duration:z.number().positive().max(30).optional()}).strict(),execute:async(_ctx,{clipId,frames,duration,...settings})=>checkpoint(t=>{
      const clip=find(t,clipId);if(clip.effectPreset!=='impact-frame')throw new Error('Choose an impact-frame FX.');
      return patchClip(t,clipId,{impact:{...DEFAULT_IMPACT,...clip.impact,...settings},...(frames!==undefined||duration!==undefined?{duration:vfxDuration(t.fps,frames,duration)}:{})});
    })}),
    addOverlay: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addOverlay,description:"Add an original procedural light-leak, film-burn, lens-flare, dust or grain overlay across a TIMELINE span. Set at to cutTime-duration/2 to bridge a cut. Give frames or duration (one frame to 30 seconds), blend screen/add/overlay, intensity 0..1, color, deterministic seed, speed 0..4, and fade 0..0.5 (fraction at each end, 0 holds full intensity). No downloaded assets or external licenses. Shared preview/export renderer. Returns effectClipId.",inputSchema:overlaySettingsSchema.partial().extend({at:z.number().min(0),frames:z.number().int().positive().optional(),duration:z.number().positive().max(30).optional()}).strict(),execute:async(_ctx,{at,frames,duration,...settings})=>{
      const effectClipId=crypto.randomUUID();
      const saved=await checkpoint(t=>patchClip(addEffectClip(t,effectClipId,'texture-overlay',at,{duration:vfxDuration(t.fps,frames,duration)}),effectClipId,{overlay:{...DEFAULT_OVERLAY,...settings}}));
      return {...saved,effectClipId};
    }}),
    configureOverlay:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureOverlay,description:"Change a procedural texture-overlay FX preset, blend, intensity, color, seed, speed or fade. Optional frames or duration changes its length. Preserve every omitted control and all other clips.",inputSchema:overlaySettingsSchema.partial().extend({clipId:z.string().min(1),frames:z.number().int().positive().optional(),duration:z.number().positive().max(30).optional()}).strict(),execute:async(_ctx,{clipId,frames,duration,...settings})=>checkpoint(t=>{
      const clip=find(t,clipId);if(clip.effectPreset!=='texture-overlay')throw new Error('Choose a texture-overlay FX.');
      return patchClip(t,clipId,{overlay:{...DEFAULT_OVERLAY,...clip.overlay,...settings},...(frames!==undefined||duration!==undefined?{duration:vfxDuration(t.fps,frames,duration),overlayTiming:{duration:vfxDuration(t.fps,frames,duration),offset:0}}:{})});
    })}),
    freezeFrameParallax:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.freezeFrameParallax,description:"Freeze a video frame at TIMELINE at, then make a 2.5D camera move for .2..10 seconds. Reuses freezeFrame placement: mode insert ripples later clips/markers, hold replaces picture while audio continues. Media worker uses fal Depth Anything V2, BiRefNet V2 salient-foreground matting and SDXL background inpainting (FAL_KEY, paid inference). Optional seed selects a source point/box, inspectFrames target, or noun. Selected subjects: MCP clients (external agents such as Claude, ChatGPT, Codex) get SAM 3.1 on Meta's Model API for the mask and noun grounding (needs MODEL_API_KEY on the worker; fails clearly without it, never SAM2); Revline's in-app agent uses SAM2 on fal with Florence-2 noun grounding. Without a seed, BiRefNet falls back to SAM2 auto-segment on fal when empty. Inspect the mask on gameplay. Optional backgroundPrompt describes the EMPTY environment. amount controls depth displacement (0..0.12), panX/Y -1..1, orbit -8..8 degrees, zoom 1..1.3. At most 1920 pixels per layer's longest edge. Preview/export share a WebGL depth/layer renderer over one compact atlas. Returns stillClipId and model provenance. Can take several minutes; retry reuses a completed atlas.",inputSchema:parallaxSettingsSchema.partial().extend({clipId:z.string().min(1),at:z.number().min(0),duration:z.number().min(.2).max(10),mode:z.enum(FREEZE_MODES).optional(),backgroundPrompt:z.string().trim().min(1).max(500).optional(),seed:pixelSeedInput.optional()}).strict(),execute:async(_ctx,{clipId,at,duration,mode,backgroundPrompt,seed,...settings})=>reportAnalysisFailure(async()=>{
      await editSession.wait();const clip=find(editSession.timeline,clipId);
      if(clip.kind!=='video'||!clip.assetId)throw new Error('Choose a video clip.');
      const frame=1/editSession.timeline.fps;
      if(at<clip.start||at>clip.start+clip.duration)throw new Error('Choose a freeze time inside this clip.');
      const snappedAt=Math.round(at*editSession.timeline.fps)/editSession.timeline.fps;
      const time=sourceTimeAt(clip,Math.min(snappedAt,clip.start+clip.duration-frame));
      const started=await derive({clipId,assetId:clip.assetId,op:'parallax',start:time,end:time,time,...(seed?{selection:{time,seed:resolveSubjectSeed(seed,clip.assetId,time)}}:{}),...(backgroundPrompt?{backgroundPrompt}:{}),placeLater:false});
      const atlas=started.status==='completed'&&started.outputAssetId?await adoptAsset(started.outputAssetId):await awaitDerivation(started.derivationId,7*60_000);
      const stillClipId=crypto.randomUUID(),splitIds=[crypto.randomUUID(),crypto.randomUUID()];
      const saved=await checkpoint(t=>{
        let allocation=0;
        const next=insertFreezeFrame(t,clipId,snappedAt,duration,mode??'insert',atlas._id,()=>allocation++===0?stillClipId:splitIds[allocation-2]);
        return patchClip(next,stillClipId,{parallax:{...DEFAULT_PARALLAX,...settings,duration:find(next,stillClipId).duration}});
      });
      return {...saved,stillClipId,models:{depth:'Depth Anything V2',foreground:seed?(mcpSurface?'SAM 3.1 (Meta Model API) selected subject':'SAM2 (fal) selected subject'):'BiRefNet V2 with SAM2 auto-segment fallback',...(seed?.kind==='object'?{grounding:mcpSurface?'SAM 3.1 (Meta Model API)':'Florence-2 (fal)'}:{}),background:'SDXL inpainting'},inference:seed&&mcpSurface?'fal.ai and Meta Model API via media worker':'fal.ai via media worker',estimatedUsd:started.estimatedUsd};
    })}),
    configureParallax:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureParallax,description:"Adjust the virtual camera of a prepared parallax freeze image without rerunning models. amount 0..0.12, panX/Y -1..1, orbit -8..8 degrees and zoom 1..1.3. Its existing hold length stays intact.",inputSchema:parallaxSettingsSchema.omit({duration:true}).partial().extend({clipId:z.string().min(1)}).strict(),execute:async(_ctx,{clipId,...settings})=>checkpoint(t=>{const clip=find(t,clipId);if(!clip.parallax)throw new Error('Choose a prepared parallax freeze.');return patchClip(t,clipId,{parallax:{...clip.parallax,...settings}});})}),
    freezeFrame: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.freezeFrame, description: "Freeze one video clip's picture at a timeline moment, as a still that keeps the clip's framing, crop and look. mode insert (default): the timeline grows by `duration`; everything from that moment on (all layers, markers) moves later, then the clip resumes. mode hold: the picture holds for `duration` while the clip's sound plays on, then the video resumes in sync (skipping the held footage). Classic uses: freeze on a reaction or punchline and add a caption, label or zoom on the still (it is an image clip; animateClip, setVisualEffects and text work on it). Takes a few seconds. Returns stillClipId.", inputSchema: z.object({ clipId: z.string().min(1), at: z.number().min(0).describe('Timeline seconds inside the clip'), duration: z.number().min(MIN_FREEZE_SECONDS).max(MAX_FREEZE_SECONDS), mode: z.enum(FREEZE_MODES).optional() }).strict(), execute: async (_ctx, input) => reportAnalysisFailure(async () => {
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId);
      if (clip.kind !== 'video' || !clip.assetId) throw new Error('Freeze a video clip.');
      if (input.at < clip.start - 1e-6 || input.at > clip.start + clip.duration + 1e-6) throw new Error(`Choose a time between ${clip.start.toFixed(2)} and ${(clip.start + clip.duration).toFixed(2)}.`);
      const frame = 1 / editSession.timeline.fps, time = sourceTimeAt(clip, Math.min(input.at, clip.start + clip.duration - frame));
      const started = await derive({ clipId: clip.id, assetId: clip.assetId, op: 'freeze', start: time, end: time, time, placeLater: false });
      const still = started.status === 'completed' && started.outputAssetId ? await adoptAsset(started.outputAssetId) : await awaitDerivation(started.derivationId, 120_000);
      let stillClipId = '';
      const saved = await checkpoint(t => insertFreezeFrame(t, input.clipId, input.at, input.duration, input.mode ?? 'insert', still._id, () => { const id = crypto.randomUUID(); if (!stillClipId) stillClipId = id; return id; }));
      return { ...saved, stillClipId };
    }) }),
    smoothSlowMotion: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.smoothSlowMotion, description: "Make slow motion smooth: AI frame interpolation (fal.ai RIFE) generates the in-between frames, so a slowed clip plays fluidly instead of stuttering. Optionally set a constant `rate` (0.25..1) in the same call; otherwise it uses the clip's current speed or speed ramp (its slowest point decides how many frames to add, up to 8x). Up to 30 seconds of footage. Runs in the background for about 1-3 minutes and costs the user's fal.ai credit; the clip switches to the smooth footage automatically after this turn's edits are saved. Use when the user asks for smooth or buttery slow-mo, or after a strong slow-down (0.5x or slower) on fast action.", inputSchema: z.object({ clipId: z.string().min(1), rate: z.number().min(.25).max(1).optional() }).strict(), execute: async (_ctx, input) => {
      let saved: Awaited<ReturnType<typeof checkpoint>> | undefined;
      if (input.rate !== undefined) saved = await checkpoint(t => setClipPlaybackRate(t, input.clipId, input.rate!));
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId);
      if (clip.kind !== 'video' || !clip.assetId) throw new Error('Choose a video clip.');
      const slowest = clip.speedRamp?.length ? Math.min(...clip.speedRamp.map(point => point.v)) : playbackRateOf(clip);
      if (slowest > .8) throw new Error('This clip plays near normal speed, so it needs no extra frames. Slow it down first (rate, or setSpeedRamp).');
      const factor = Math.min(8, Math.max(2, Math.ceil(1 / slowest - 1e-6)));
      const started = await derive({ clipId: clip.id, assetId: clip.assetId, op: 'slowmo', start: clip.sourceStart, end: sourceEndOf(clip), factor, fps: editSession.timeline.fps, placeLater: true });
      if (started.status === 'completed' && started.outputAssetId) { await adoptAsset(started.outputAssetId); saved = await checkpoint(t => patchClip(t, clip.id, { assetId: started.outputAssetId! })); return { ...saved, applied: true, reusedExisting: true, factor, estimatedUsd: 0 }; }
      return { ...(saved ?? {}), started: true, factor, estimatedUsd: started.estimatedUsd, note: 'Frame interpolation is processing; the clip switches to the smooth footage automatically when it finishes.' };
    } }),
    upscaleClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.upscaleClip, description: "AI-upscale low-resolution footage or an image (fal.ai) so it stays sharp in a 1080p or 4K export: for small screen recordings, old clips, zoomed-in crops or low-res images. `target` is the short side in pixels (1080 default, 1440 or 2160). Video: up to 60 seconds of the clip's footage, about 2-5 minutes in the background, costs the user's fal.ai credit (quoted as estimatedUsd), and the clip switches automatically after this turn's edits are saved. Images switch the same way. Refuses media that is already at least the target size.", inputSchema: z.object({ clipId: z.string().min(1), target: z.union([z.literal(1080), z.literal(1440), z.literal(2160)]).optional() }).strict(), execute: async (_ctx, input) => {
      await editSession.wait();
      const clip = find(editSession.timeline, input.clipId), target = input.target ?? 1080;
      if ((clip.kind !== 'video' && clip.kind !== 'image') || !clip.assetId) throw new Error('Upscale a video or image clip.');
      const asset = await loadAsset(clip.assetId);
      if (asset.width && asset.height && Math.min(asset.width, asset.height) >= target) throw new Error(`This media is already ${asset.width}x${asset.height}, at least ${target}p. It needs no upscale.`);
      const started = await derive({ clipId: clip.id, assetId: clip.assetId, op: 'upscale', start: clip.kind === 'video' ? clip.sourceStart : 0, end: clip.kind === 'video' ? sourceEndOf(clip) : 0, target, fps: editSession.timeline.fps, placeLater: true });
      if (started.status === 'completed' && started.outputAssetId) { await adoptAsset(started.outputAssetId); const saved = await checkpoint(t => patchClip(t, clip.id, { assetId: started.outputAssetId! })); return { ...saved, applied: true, reusedExisting: true, estimatedUsd: 0 }; }
      return { started: true, estimatedUsd: started.estimatedUsd, note: 'Upscaling is processing; the clip switches to the sharper media automatically when it finishes.' };
    } }),
    setPlaybackRate: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setPlaybackRate, description: "Change a video or audio clip’s constant playback speed from 0.25× to 4×. Preserve its retained source footage; adjust timeline duration and linked sound together. Slowing down refuses overlaps, so make room first rather than moving unrelated clips. This is constant speed, not a speed ramp.", inputSchema: z.object({ clipId: z.string(), rate: z.number().min(.25).max(4) }), execute: async (_ctx, input) => checkpoint(t => setClipPlaybackRate(t, input.clipId, input.rate)) }),
    resetVisualEffect:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.resetVisualEffect,description:"Reset one requested footage effect group to defaults (retain its enabled state) or remove that group. Preserve every other group, clip and audio. Resetting dither restores the original RGB colors.",inputSchema:z.object({clipId:z.string(),effect:z.enum(OFFERED_VISUAL_EFFECT_GROUPS),action:z.enum(['reset','remove'])}),execute:async(_ctx,{clipId,effect,action})=>checkpoint(t=>patchClip(t,clipId,visualEffectActionPatch(find(t,clipId),effect,action)))}),
    applyTextTemplate: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyTextTemplate, description: "Apply supported text template motion to a caption/graphic while preserving existing words, appearance, font, position, rotation and timing. Word reveal, Pop-in words, Sliding title, Karaoke, Neon Echo, Lyric Slam, Kinetic Stack, Chromatic split (RGB split), Outline trails, Cinematic focus, Character scramble, Spotlight sweep, Ink write-on and Echo tunnel are animations, not styled text presets. Chromatic split adds colored offsets, Outline trails adds echo trails, Cinematic focus brings words into focus, and Character scramble settles temporary display letters into the original words. Spotlight sweep moves accent light across the title; Ink write-on reveals outlines before filled lettering; Echo tunnel brings repeated outlines forward into the title. For a look use applyTextLook. Karaoke preserves saved speech-word timings when present; otherwise it uses even duration progress, not detected syllables or beat sync.", inputSchema: z.object({ clipId: z.string(), preset: z.enum(TEXT_TEMPLATE_PRESETS) }), execute: async (_ctx, input) => checkpoint(t => { const clip = find(t, input.clipId); return patchClip(t, clip.id, textTemplatePatch(clip, input.preset)); }) }),
    configureTextTemplate: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureTextTemplate, description: "Change a caption/graphic text template's highlight/accent color or requested animation controls, or choose a supported template. Chromatic split (rgb-split), Outline trails (type-trails), Cinematic focus (blur-focus), Character scramble, Spotlight sweep, Ink write-on and Echo tunnel support strength .2..2 (default 1), revealDuration .15..3 seconds (default .65), and stagger 0.. .18 seconds per character/word (default .07). These controls do not change clip duration, stored words or timing. Keep omitted controls, outer animation, appearance and rotation intact. Control-only edits and same-preset reselection preserve the original duration/offset clock; choosing a different preset starts its entrance on the retained clip. Colors are six-digit hex; templates and outer text animation can combine. Karaoke with speech timings takes karaokeStyle box (highlight pill behind the active word) or pop (words pop in as spoken, active word in the highlight color, outline kept). Saves immediately.", inputSchema:z.object({clipId:z.string(),preset:z.enum(TEXT_TEMPLATE_PRESETS).optional(),highlightColor:z.string().regex(/^#[\da-f]{6}$/i).optional(),karaokeStyle:z.enum(['box','pop']).optional(),strength:z.number().min(.2).max(2).optional(),revealDuration:z.number().min(.15).max(3).optional(),stagger:z.number().min(0).max(.18).optional()}).refine(input=>Object.entries(input).some(([key,value])=>key!=='clipId'&&value!==undefined),{message:'Specify a text template, highlight color or animation control.'}),execute:async(_ctx,{clipId,preset,...changes})=>checkpoint(t=>{
      const clip=find(t,clipId);if(clip.kind!=='caption'&&clip.kind!=='graphic')throw new Error('Choose a caption or text graphic.');
      const patch=preset&&preset!==clip.textTemplate?.preset?textTemplatePatch(clip,preset):{},template=patch.textTemplate??clip.textTemplate;
      if(!template)throw new Error('Choose a text template before changing its appearance or animation controls.');
      return patchClip(t,clipId,{...patch,textTemplate:{...template,...changes}});
    })}),
    addTimedEffect: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.addTimedEffect, description: `For explicit effects or authorized creative styling: add a supported independent FX clip (solid-color instead creates a normal V color layer): ${OFFERED_TIMED_EFFECT_PRESETS.map(preset=>EFFECT_CATALOG[preset].label).join(', ')}. One planId maps to one FX clip with the same start and full duration; plan repeated pulses separately. It affects the visual composition during its range; use explicit start or current playhead. Punch is the returning pulse in the Zoom family. It has amount1..3, speed.25..4 and centerX/centerY0..1. Optional attack/release are .01..30 seconds at1x speed; speed scales both, and if their total exceeds the FX duration both fit proportionally. Omitted timing fields preserve the legacy pulse; partial timing edits preserve every omitted control. Quick zoom in/out are one configurable Zoom family: optional zoom direction in/out, amount 1..3 times normal framing, speed 0.25..4 and centerX/centerY 0..1. Speed is progression relative to the FX range: 1 completes across the range, faster reaches the target early and holds, slower ends partway. Optional solidColor controls configure a solid-color V frame/rectangle only. Solid color follows V layer stacking; put it below footage for a background or above it for an overlay. This is independent of footage and sound timing. Footage fade in/out belongs to configureVisualFade, and sound fades to configureAudio; do not create a separate fade FX. Use addTransition for a real neighboring-pair transition. Frame shrink scales the footage itself toward the canvas center with black space on all four sides, then returns; it is not a solid-color rectangle.`, inputSchema: z.object({ planId:z.string().optional(),preset:z.enum(OFFERED_TIMED_EFFECT_PRESETS),start:z.number().min(0).optional(),duration:z.number().positive().optional(),aboveClipId:z.string().optional(),solidColor:solidColorInput.optional(),zoom:zoomInput.optional(),...pulseInputs }).strict().refine(input=>!input.zoom||isZoomPreset(input.preset),{message:'Zoom controls belong to Zoom FX.'}).refine(input=>!input.solidColor||input.preset==='solid-color',{message:'Solid color controls belong to solid-color FX.'}).refine(input=>!input.flash||input.preset==='flash',{message:'Flash controls require flash FX.'}).refine(input=>!input.shake||input.preset==='shake',{message:'Shake controls require shake FX.'}).refine(input=>!input.punch||input.preset==='punch',{message:'Controls must match the requested effect preset.'}), execute:async(_ctx,input)=>checkpoint(t=>{
      const start=input.start??options.playhead??0,plan=effectPlans.find(plan=>(!input.planId||plan.id===input.planId)&&plan.kind==='timed'&&plan.effect===input.preset&&Math.abs(plan.start-start)<1/t.fps);
      if(!plan&&!options.planlessEffects&&recipe().fullTools&&laneToolAllowed(lane,'planEffects',[...capabilities]))throw new Error('Record this effect with planEffects before adding it.');
      if(plan&&Math.abs((input.duration??plan.duration)-plan.duration)>1/t.fps)throw new Error('Match the timed plan duration to this one FX clip. Plan each separate pulse with its own ID and range.');
      const duration=input.duration??plan?.duration;if(duration===undefined)throw new Error('Give the effect a duration in seconds.');
      const id=crypto.randomUUID();if(plan)planBindings.set(plan.id,id);
      const next=addEffectClip(t,id,input.preset,start,{duration,aboveClipId:input.aboveClipId});
      if(input.zoom)return patchClip(next,id,configureTimedEffectPatch(find(next,id),{zoom:input.zoom}));
      if(input.solidColor)return patchClip(next,id,solidColorPatch(find(next,id),input.solidColor));
      return input.punch||input.flash||input.shake?patchClip(next,id,configureTimedEffectPatch(find(next,id),{punch:input.punch,flash:input.flash,shake:input.shake})):next;
    })}),
    convertSolidColorToVisual:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.convertSolidColorToVisual,description:"Move an existing saved solid-color FX rectangle to a normal V layer so it can be placed behind or above footage. Preserve its color, size, position, opacity, timing and motion. Use only when the user wants that solid on a visual layer or behind footage. Already-normal V colors are unchanged.",inputSchema:z.object({clipId:z.string()}),execute:async(_ctx,{clipId})=>checkpoint(t=>convertSolidColorToVisual(t,clipId))}),
    setSolidColor:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setSolidColor,description:"Configure an existing solid-color V layer or saved legacy FX frame/rectangle's requested color, normalized width/height/center x/y or opacity. Width/height are fractions of output dimensions (1 fills that axis); x/y0.5 is centered. Preserve omitted controls and all footage/audio. Saves immediately.",inputSchema:solidColorInput.extend({clipId:z.string()}).refine(input=>Object.entries(input).some(([key,value])=>key!=='clipId'&&value!==undefined),{message:'Specify a solid color control.'}),execute:async(_ctx,{clipId,...changes})=>checkpoint(t=>patchClip(t,clipId,solidColorPatch(find(t,clipId),changes)))}),
    configureTimedEffect:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.configureTimedEffect,description:"Customize a requested existing timed FX starting point: switch its supported preset or stretch duration. Punch is the returning pulse in the Zoom family. It has amount1..3, speed.25..4 and centerX/centerY0..1. Optional attack/release are .01..30 seconds at1x speed; speed scales both, and if their total exceeds the FX duration both fit proportionally. Omitted timing fields preserve the legacy pulse; partial timing edits preserve every omitted control. Zoom quick-zoom-in/out share optional zoom direction in/out, amount 1..3, speed 0.25..4, centerX/centerY 0..1; 1 completes across the FX range, faster reaches the target early and holds, slower ends partway. Preserve omitted controls, clip start and all other footage/FX/audio. Use setSolidColor for solid-color settings. Existing saved legacy fade FX can retain duration edits; new footage/audio fades use configureVisualFade/configureAudio.",inputSchema:z.object({clipId:z.string(),preset:z.enum(OFFERED_TIMED_EFFECT_PRESETS).optional(),duration:z.number().positive().optional(),...pulseInputs,zoom:zoomInput.optional()}).strict().refine(input=>input.preset!==undefined||input.duration!==undefined||input.zoom!==undefined||input.punch!==undefined||input.flash!==undefined||input.shake!==undefined,{message:'Specify a timed effect control.'}),execute:async(_ctx,{clipId,...changes})=>checkpoint(t=>patchClip(t,clipId,configureTimedEffectPatch(find(t,clipId),changes)))}),
    applyMotionPreset: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyMotionPreset, description: "Set a caption or text graphic's animation: none, fade, rise, or pop. Text animation only; use setVisualEffects for footage color, zoom blur or glitch when effects or creative styling are requested. Saves immediately.", inputSchema: z.object({ clipId: z.string(), preset: z.enum(TEXT_EFFECT_PRESETS) }), execute: async (_ctx, input) => checkpoint(t => {
      const clip = find(t, input.clipId);
      return patchClip(t, clip.id, textEffectPatch(clip, input.preset));
    }) }),
    animateClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.animateClip, description: "Animate one object, or batch distinct objects with objects:[{clipId,keyframes,replaceMotion?}] in one atomic edit. For scattered words aligning into a line, inspect their static placement, use individual final canvas offsets and matching absolute timeline arrival times (convert to each clip-local time). Include a baseline/hold before the alignment starts, retain every word as a separate editable object, and do not change unselected clips. Animate a VIDEO clip, CAPTION, TEXT GRAPHIC, UPLOADED IMAGE overlay or SOLID-COLOR object as a whole (move, scale, rotate, fade, brighten it on the canvas, e.g. a picture-in-picture video sliding in). This is object motion in canvas coordinates, not a camera or automatic attachment to another clip. keyframes use CLIP-LOCAL timeline seconds within its duration. x/y are offsets as fractions of canvas width/height relative to the object's static placement, not original-source target coordinates. For video and image clips the tool maps those canvas offsets through inverse static scale/rotation so small or rotated overlays still move the requested canvas distance; scale/opacity multiply current values, rotation uses degrees, brightness1 is unchanged. Keep the static base layout and sources. Optional destination-anchor easing: linear, ease-in-out, ease-out, focused-spring, or a custom cubic-bézier curve [x1,y1,x2,y2] (x1/x2 in 0..1; y above 1 overshoots, e.g. [0.34,1.56,0.64,1] for a springy pop, [0.7,0,0.84,0] for a slow-start ease-in). Eased paths accept2–8 anchors, batch the entire path in one call; without non-linear easing, existing linear paths accept0–120 points. First/last states hold outside the provided anchors; add an explicit0-second baseline point when motion must begin later. Replaces only this object's custom motion. A prior image camera/smoothZoom recipe requires explicit user replacement permission and replaceMotion:true; otherwise use configureCameraMotion to edit that camera path. To push or pan INSIDE footage (camera reframing) use configureSmoothZoom/configureCameraMotion instead; animateClip moves the whole video frame. Coordinate any chosen image/text/solid's timing with a footage camera path only when requested, by planning both paths in their respective coordinate spaces. Do not claim parenting, automatic scene attachment or automatic continuous cursor tracking. Text motion replaces basic text animation but preserves its styling and existing text-template settings. Add setMotionBlur afterwards for premium-feeling fast moves.", inputSchema:objectMotionInput.partial().extend({objects:z.array(objectMotionInput).min(1).max(32).optional()}).strict().refine(input=>input.objects!==undefined?input.clipId===undefined&&input.keyframes===undefined&&input.replaceMotion===undefined:input.clipId!==undefined&&input.keyframes!==undefined,{message:'Send one clipId with keyframes, or an objects batch, not both.'}), execute:async(_ctx,input)=>checkpoint(t=>animateObjects(t,input.objects??[{clipId:input.clipId!,keyframes:input.keyframes!,replaceMotion:input.replaceMotion}])) }),
    cropClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.cropClip, description: "Set requested crop edge amounts on a video/image. units defaults normalized source-axis fractions; units pixels uses recorded intrinsic asset width for left/right and height for top/bottom. Require known positive source dimensions for pixels; never invent source geometry. Opposing edges must leave more than 5% per axis. Preserve omitted edges, source placement/fitted size, transform, fit, volume and timing; crop masks without zooming the source.", inputSchema: z.object({ clipId: z.string(),units:z.enum(VISUAL_INPUT_UNITS).optional(), top: z.number().min(0).optional(), right: z.number().min(0).optional(), bottom: z.number().min(0).optional(), left: z.number().min(0).optional() }), execute: async (_ctx, input) => checkpoint(t => {
      const {clipId,units,...changes}=input;const clip=find(t,clipId),asset=assets.find(asset=>asset._id===clip.assetId);
      return patchClip(t,clipId,cropInputPatch(clip,changes,asset??{},units));
    }) }),
    applyLayout:createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyLayout,description:"Apply a composition preset to exact existing video/image clips. Preserve source ranges, timing, sound, effects and all unselected clips. layout \"two-rows\": supporting clips in topClipIds, explanation/narrator in bottomClipIds; each row fills half the current canvas without stretching the source. Set detectedRegions:true to use saved facecam rectangles for the top row and gameplay for the bottom automatically, refusing uncertain or changing layouts. This only sets framing; arrange overlapping row footage on separate V layers with explicit timeline tools when needed. layout \"mirror-blur\": for a wide source on a taller canvas (9:16, 4:5, 1:1); each clip in clipIds stays sharp, fit to the full width in the middle (its crop and position are replaced), and the space above and below fills with blurred, darkened, muted copies of the same clip and source range, flipped so each copy meets the sharp clip at the matching edge. Copies go on new V layers beneath the clip; only the middle clip keeps audio. Returns the copy clip IDs per middle clip. Selected clips must share one V layer and not overlap in time. Refuses a source that already fills the canvas height or a clip that already has mirror copies. Existing custom object motion/legacy follow crop must be resolved explicitly first; do not silently remove it.",inputSchema:z.object({layout:z.enum(['two-rows','mirror-blur']),detectedRegions:z.boolean().optional(),topClipIds:z.array(z.string().min(1)).max(100).optional(),bottomClipIds:z.array(z.string().min(1)).max(100).optional(),clipIds:z.array(z.string().min(1)).max(100).optional().describe('mirror-blur only: the clips that stay sharp in the middle.')}),execute:async(_ctx,{layout,topClipIds=[],bottomClipIds=[],clipIds=[],detectedRegions})=>{if(layout==='mirror-blur'){if(!clipIds.length)throw new Error('Choose clipIds for the mirror blur layout.');if(topClipIds.length||bottomClipIds.length||detectedRegions)throw new Error('mirror-blur takes clipIds only; topClipIds, bottomClipIds and detectedRegions belong to two-rows.');let copies:Record<string,string[]>={};const saved=await checkpoint(t=>{const result=applyMirrorBlurLayout(t,assets,clipIds);copies=result.copies;return result.timeline;});return {...saved,mirrorCopyClipIds:copies};}if(clipIds.length)throw new Error('two-rows takes topClipIds and bottomClipIds, not clipIds.');if(topClipIds.length+bottomClipIds.length===0)throw new Error('Choose footage for at least one row.');if(detectedRegions)for(const id of new Set([...topClipIds,...bottomClipIds].map(id=>find(editSession.timeline,id).assetId))){if(!id)throw new Error('Choose source footage.');await analyze(id,'facecam');}return checkpoint(t=>applyTwoRowLayout(t,assets,{topClipIds,bottomClipIds,detectedRegions}));}}),
    fitClip: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.fitClip, description: "Fit a video/image into its frame (contain, preserving the complete source) or fill the frame (cover, cropping overflow); save immediately.", inputSchema: z.object({ clipId: z.string(), fit: z.enum(["cover", "contain"]) }), execute: async (_ctx, input) => checkpoint(t => { const clip = find(t, input.clipId); if (clip.kind !== "video" && clip.kind !== "image") throw new Error("Choose a video or image"); return patchClip(t, clip.id, { fit: input.fit }); }) }),
    resetVisual: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.resetVisual, description: "Reset a video/image's position, scale, rotation, opacity, flip, and edge crop to defaults; save immediately.", inputSchema: z.object({ clipId: z.string() }), execute: async (_ctx, input) => checkpoint(t => { const clip = find(t, input.clipId); if (clip.kind !== "video" && clip.kind !== "image") throw new Error("Choose a video or image"); return patchClip(t, clip.id, { transform: undefined, crop: undefined, fit: undefined, flip: undefined }); }) }),
    setAspectRatio: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.setAspectRatio, description: "Set the canvas aspect ratio; save immediately.", inputSchema: z.object({ aspectRatio: z.enum(aspectRatioValidator.members.map(member => member.value)) }), execute: async (_ctx, input) => checkpoint(t => ({ ...t, aspectRatio: input.aspectRatio })) }),
    followSubject: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.followSubject, description: "Enable subject-follow crop on a video clip, requesting real background tracking when absent. mode active-speaker first detects camera cuts on CPU and holds a dominant face for each shot, including profiles with obscured mouths. Wide shots use whole-turn mouth activity with Deepgram diarization and remembered face identities. Short backchannels and uncertain/offscreen matches never trigger a switch. Crop changes cut at camera cuts and ease only between confirmed speakers inside a shot. Returns retained seconds and confidence by shot-dominant, turn-mouth, identity-reuse and fallback. Shot dominance is framing evidence, not voice identity. No Gemini or GPU is required. Set enabled:false to turn off existing follow crop immediately without any analysis. Preserve source/timing and other crop/transform controls. active-speaker analyzes only the retained SOURCE window, up to 120 source seconds, reusing saved coverage, analyzeMedia speakers results for the same window and diarized words; only missing audio is diarized. Uncertain intervals hold the current crop within a shot; an uncertain new shot starts from the stable center; if every interval is uncertain it returns applied:false and applies no crop. Receipt confidences are duration-weighted heuristics, not calibrated probabilities.", inputSchema: z.object({ clipId: z.string(),enabled:z.boolean().optional(),mode:z.enum(['face','active-speaker']).optional() }), execute: async (_ctx, input) => {
      if(input.enabled===false)return checkpoint(t=>{const clip=find(t,input.clipId);if(clip.kind!=='video')throw new Error('Choose a video clip.');return patchClip(t,clip.id,{focus:undefined,framingCuts:undefined})});
      const selected = find(editSession.timeline, input.clipId); const source = selected.assetId?await loadAsset(selected.assetId):undefined;
      if (selected.kind !== "video" || !source) throw new Error("Choose an uploaded video clip");
      if(input.mode==='active-speaker'){
        const evidence=await analyze(source._id,'speakers',false,{start:selected.sourceStart,end:Math.min(source.duration??sourceEndOf(selected),sourceEndOf(selected))}),speakers=evidence.analysis?.speakers;
        const framing=speakers?summarizeSpeakerFraming(speakers,selected.sourceStart,sourceEndOf(selected),time=>timelineTimeAtSource(selected,time)):null;
        if(!speakers||!framing?.some(row=>row.method!=='fallback'&&row.seconds>0))return {applied:false,reason:'No confident shot framing or visible speaker match. Keep a stable wider view.',framing};
        const saved=await checkpoint(t=>{const clip=find(t,input.clipId);if(clip.motion?.length)throw new Error('Resolve existing custom camera motion before following speakers.');return patchClip(t,clip.id,{focus:focusForClip(speakers.focus,clip),framingCuts:speakers.version===2?speakers.framing.filter((f,i,all)=>!i||f.shot!==all[i-1].shot||f.faceId!==all[i-1].faceId).map(f=>f.start):speakers.turns.filter((f,i,all)=>!i||f.speaker!==all[i-1].speaker).map(f=>f.start)});});
        return {...saved,framing,framingTimeBasis:'retained timeline seconds',confidenceBasis:'Duration-weighted framing evidence, not a calibrated voice-identity probability. Shot dominance does not identify the voice.'};
      }
      if (!source.analysis?.focus?.length) await analyze(source._id, "track");
      return checkpoint(t => { const clip = find(t, input.clipId); const asset = assets.find(current => current._id === clip.assetId); if (clip.kind !== "video" || !asset?.analysis?.focus?.length) throw new Error("No visible subject was detected in this video"); return patchClip(t, input.clipId, { focus: focusForClip(asset.analysis.focus, clip) }); });
    } }),
    removeBackground: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.removeBackground, description: "Ultra only. Remove the background of a video clip. mode person (default) uses fal person matting with soft hair edges; mode foreground uses BiRefNet V2 to keep salient foreground content, including objects or game characters. Optional seed uses the same point, box, object noun or inspected target as trackPoints. time is the TIMELINE seed second (defaults to clip start). Selected subjects: MCP clients (external agents) get SAM 3.1 on Meta's Model API for noun grounding and the tracked subject mask (MODEL_API_KEY on the worker; fails clearly without it, never SAM2); Revline's in-app agent uses Florence-2 noun grounding and SAM2 on fal. Automatic BiRefNet falls back to SAM2 on fal if empty. Inspect the matte. Runs in the media worker using fal (and, for MCP subjects, Meta) credit; the clip switches to transparent WebM after the edit finishes. Put text or replacement visuals on a lower V layer.", inputSchema: z.object({ clipId: z.string().min(1), mode: z.enum(['person','foreground']).optional(), seed: pixelSeedInput.optional(), time:z.number().nonnegative().optional() }).strict(), execute: async (_ctx, { clipId, mode, seed, time }) => {
      await editSession.wait();const clip=find(editSession.timeline,clipId);
      const at=time??clip.start;
      if(at<clip.start||at>=clip.start+clip.duration)throw new Error('Choose a subject seed time inside the clip.');
      const sourceTime=sourceTimeAt(clip,at);
      const result = await ctx.runMutation(internal.cutouts.startFromRun, { ...run, clipId, ...(mode ? { mode } : {}), ...(seed?{selection:{time:sourceTime,seed:resolveSubjectSeed(seed,clip.assetId,sourceTime)}}:{}) });
      return result.reused ? { applied: true, reusedExistingCutOut: true, estimatedUsd: 0, note: 'An existing cut-out of this footage was applied; the background is already removed. Visuals belong on a lower V layer.' } : { started: !result.alreadyRunning, alreadyRunning: result.alreadyRunning, estimatedUsd: result.estimatedUsd, note: 'Background removal is processing; the clip switches to the cut-out automatically when it finishes. Visuals belong on a lower V layer.' };
    } }),
    // Genesis (MCP only): SAM 3.1 layers. Pure timeline builders live in lib/ai/lanes/genesis/functions.
    segment: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.segment, description: segmentDescription, inputSchema: segmentInput, execute: async (_ctx, input) => {
      await editSession.wait();const clip=find(editSession.timeline,input.clipId);
      if(clip.kind!=='video'||!clip.assetId)throw new Error('Choose a video clip.');
      const clipEnd=clip.start+clip.duration,from=input.start??clip.start,to=input.end??clipEnd,at=input.at??from;
      if(from<clip.start-1e-6||to>clipEnd+1e-6||to-from<1/editSession.timeline.fps)throw new Error(`Keep start/end inside clip ${clip.id} (${clip.start.toFixed(2)}–${clipEnd.toFixed(2)}s).`);
      if(at<from||at>=to)throw new Error('at must be inside the masked range.');
      const a=sourceTimeAt(clip,from),b=sourceTimeAt(clip,to);
      const started=await ctx.runMutation(internal.genesis.startFromRun,{...run,clipId:clip.id,sourceAssetId:clip.assetId,prompt:JSON.stringify(input.prompt),time:sourceTimeAt(clip,at),seed:subjectSeed(input.prompt),start:Math.min(a,b),end:Math.max(a,b),fps:editSession.timeline.fps});
      return {...started,model:'sam-3.1',provider:'Meta Model API via media worker',next:started.status==='ready'?'Apply layerEffect or textBehind with this layerId.':'Poll getLayer with this layerId every 10-15 seconds until status is ready.'};
    } }),
    getLayer: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getLayer, description: getLayerDescription, inputSchema: getLayerInput, execute: async (_ctx, {layerId, from, to}) => ctx.runQuery(internal.genesis.layerForRun, { ...run, layerId, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }) }),
    layerEffect: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.layerEffect, description: layerEffectDescription, inputSchema: layerEffectInput, execute: async (_ctx, input) => applyGenesis(input.layerId, input.clipId, `layerEffect:${input.effect}`, (t, layer, stack) => applyLayerEffect(t, layer, stack, input, () => crypto.randomUUID())) }),
    textBehind: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.textBehind, description: textBehindDescription, inputSchema: textBehindInput, execute: async (_ctx, input) => applyGenesis(input.layerId, input.clipId, 'textBehind', (t, layer, stack) => applyTextBehind(t, layer, stack, input, () => crypto.randomUUID())) }),
    depth: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.depth, description: depthDescription, inputSchema: depthInput, execute: async (_ctx, input) => {
      const started = await startGenesisJob('depth', await genesisFootage(input.clipId), {}, []);
      return { ...started, model: `Video Depth Anything ${DEPTH_MODEL}`, license: 'Apache-2.0', provider: 'fal', next: pollJob(started.status) ?? 'Pass this jobId as depthId to depthEffect or relight.' };
    } }),
    relight: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.relight, description: relightDescription, inputSchema: relightInput, execute: async (_ctx, input) => {
      if (input.layerId && !input.depthId) throw new Error('Subject relight needs depthId so the light falls off into the scene: run depth on this clip (reused by depth effects), poll getJob until ready, then relight with layerId and depthId.');
      if (input.depthId && !input.layerId) throw new Error('depthId is for subject relight. Pass layerId too, or omit depthId to relight the whole frame.');
      if (!input.layerId && input.falloff !== undefined) throw new Error('falloff applies to subject relight only.');
      const clip = await genesisFootage(input.clipId), plan = lightPlan(input.light, EXPLICIT_LIGHT_MODE);
      const params: RelightParams = { plan, scope: input.layerId ? 'subject' : 'frame', ...(input.layerId ? { layerId: input.layerId } : {}), strength: input.strength ?? 1, falloff: input.layerId ? input.falloff ?? .35 : 0, seed: input.seed ?? 7 };
      const started = await startGenesisJob('relight', clip, params, input.layerId ? [input.layerId] : [], input.depthId);
      return { ...started, model: 'LightX relight', provider: 'fal', mode: plan.mode, light: plan.label, scope: params.scope, next: pollJob(started.status) ?? 'applyJob with this jobId.' };
    } }),
    depthEffect: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.depthEffect, description: depthEffectDescription, inputSchema: depthEffectInput, execute: async (_ctx, input) => {
      const clip = await genesisFootage(input.clipId), end = clip.start + clip.duration;
      for (const time of [input.start, input.end]) if (time !== undefined && (time < clip.start - 1e-6 || time > end + 1e-6)) throw new Error(`Keep start/end inside clip ${clip.id} (${clip.start.toFixed(2)}–${end.toFixed(2)}s).`);
      const a = clip.sourceStart, b = sourceEndOf(clip);
      const params = effectParams(input, time => sourceTimeAt(clip, time), { start: Math.min(a, b), end: Math.max(a, b) });
      const started = await startGenesisJob('effect', clip, params, effectLayers(params), input.depthId);
      return { ...started, compositor: 'Genesis depth compositor (media worker, no model cost)', next: pollJob(started.status) ?? 'applyJob with this jobId.' };
    } }),
    getJob: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.getJob, description: getJobDescription, inputSchema: getJobInput, execute: async (_ctx, { jobId }) => ctx.runQuery(internal.genesisJobs.jobForRun, { ...run, jobId }) }),
    applyJob: createTool({ metadata: EDITOR_TOOL_DEFINITIONS.applyJob, description: applyJobDescription, inputSchema: applyJobInput, execute: async (_ctx, input) => {
      const job = await ctx.runQuery(internal.genesisJobs.readyForApply, { ...run, jobId: input.jobId });
      const clip = await genesisFootage(input.clipId ?? job.clipId), frame = 1 / editSession.timeline.fps;
      if (clip.assetId === job.outputAssetId) throw new Error(`Clip ${clip.id} already shows this result.`);
      if (clip.assetId !== job.sourceAssetId) throw new Error(`Clip ${clip.id} no longer shows the footage this job processed. Run the job again on this clip.`);
      // Layer functions stack copies of the original footage and subject over the clip; a new base would hide under them.
      const stack = await ctx.runQuery(internal.genesis.stackForRun, { ...run, timelineId: timelineIdForLane(), baseClipId: clip.id });
      if (stack.clipIds.some(id => editSession.timeline.clips.some(other => other.id === id))) throw new Error(`Clip ${clip.id} has layer functions (layerEffect/textBehind) stacked on it, built from the original footage. Undo them, applyJob, then use depthEffect keepLayerId for subject-aware looks.`);
      if (clip.sourceStart < job.start - frame || sourceEndOf(clip) > job.end + frame) throw new Error(`The job covers source ${job.start.toFixed(2)}–${job.end.toFixed(2)}s but clip ${clip.id} plays ${clip.sourceStart.toFixed(2)}–${sourceEndOf(clip).toFixed(2)}s. Trim the clip back or run the job again.`);
      await adoptAsset(job.outputAssetId);
      const saved = await checkpoint(t => patchClip(t, clip.id, { assetId: job.outputAssetId }));
      await ctx.runMutation(internal.genesisJobs.recordApplication, { ...run, jobId: job.jobId, timelineId: timelineIdForLane(), clipId: clip.id });
      const mid = Math.round((clip.start + clip.duration / 2) * 100) / 100;
      return { ...saved, jobId: job.jobId, clipId: clip.id, assetId: job.outputAssetId, undo: 'undoLatestEdit restores the original footage.', next: `getFrames at ${mid}s with resolution 1080 (plus the start and end of the clip), then finish.` };
    } }),
  };
  // Scenes report what they cover but were never read: a recreation reads every moment before building over it.
  // Building is refused while the range still owes reads, unless the call says why it goes ahead (readReason).
  const building = { addScene: true, addScenes: true, addFilm: true, patchScene: false, editScene: false } as const;
  for (const [name, refuses] of Object.entries(building)) {
    const tool = (tools as Record<string, { execute?: (...args: never[]) => Promise<unknown>; inputSchema?: unknown }>)[name];
    const execute = tool?.execute;
    if (!tool || !execute) continue;
    if (refuses && tool.inputSchema instanceof z.ZodObject) tool.inputSchema = tool.inputSchema.extend({ readReason: z.string().trim().min(1).max(300).optional().describe('Only when building over reference moments the read check flagged: why it cannot wait for those reads.') });
    // createTool's execute reads its ctx from \`this\` (the tool), so call it as a method of the tool.
    tool.execute = async function (this: unknown, ...args: never[]) {
      if (refuses) {
        const { readReason, ...input } = (args[0] ?? {}) as Record<string, unknown> & { readReason?: string };
        args = [input, ...args.slice(1)] as never[];
        const ranges = sceneRanges(name, input);
        const checks = readReason || LANES[lane].referenceMotion !== 'required' || coverage.referenceAssetId() !== referenceAssetId() ? [] : ranges.map(range => coverage.sceneCheck(range.start, range.end)).filter(check => !!check);
        if (checks.length) return { success: false, saved: false, refused: 'reads', readCheck: `Nothing was built. ${checks.map(check => check.readCheck).join(' ')} Then call ${name} again. Pass readReason only if a flagged moment truly cannot be read.`, ...readLists(checks) };
      }
      const output = await execute.apply(this ?? tool, args) as Record<string, unknown>;
      const ids = new Set<string>([...(Array.isArray(output?.changedClips) ? output.changedClips : []).map(clip => String((clip as { id?: unknown }).id)), ...(Array.isArray(output?.scenes) ? output.scenes : []).map(scene => String((scene as { clipId?: unknown }).clipId))]);
      const ranges = name === 'addFilm' ? sceneRanges(name, args[0] ?? {}) : editSession.timeline.clips.filter(clip => clip.kind === 'scene' && ids.has(clip.id)).flatMap(clip => {
        const beats = clip.scene?.film ? sectionRanges(clip.scene) : [];
        return beats.length ? beats.map(beat => ({ start: Math.max(clip.start, timelineTimeAtSource(clip, beat.start)), end: Math.min(clip.start + clip.duration, timelineTimeAtSource(clip, beat.end)) })).filter(range => range.end > range.start) : [{ start: clip.start, end: clip.start + clip.duration }];
      });
      const checks = recipe().fullTools && LANES[lane].referenceMotion === 'required' && coverage.referenceAssetId() === referenceAssetId() ? ranges.map(range => coverage.sceneCheck(range.start, range.end)).filter(check => !!check) : [];
      return checks.length ? { ...output, readCheck: checks.map(check => check.readCheck).join(' '), ...readLists(checks) } : output;
    };
  }
  // Track which tools are running or staged an edit, for editingTools above. createTool's execute reads its ctx from `this`.
  for (const [name, tool] of Object.entries(tools) as [string, { execute?: (...args: never[]) => Promise<unknown> }][]) {
    const execute = tool.execute;
    if (!execute) continue;
    tool.execute = async function (this: unknown, ...args: never[]) {
      const input = (args[0] ?? {}) as { mode?: string; name?: string; page?: string; start?: number; end?: number; scope?: ScopeInput | ScopeInput[]; clipId?: string; times?: number[]; count?: number; fps?: number; stillsOnly?: boolean; momentsOnly?: boolean };
      if (!recipe().fullTools && FULL_CHECK_TOOLS.has(name)) return { success: false, error: fullCheckRefusal(lane, name) };
      const batchedReelStills = lane === 'reel' && input.stillsOnly === true && input.fps === undefined && !input.momentsOnly && (input.times ? input.times.length <= 30 : (input.count ?? 8) <= 12);
      if (recipe().boundedReads && name === 'readFrames' && !batchedReelStills && (input.start === undefined || input.end === undefined || input.end - input.start > 3)) return { success: false, error: BOUNDED_READ_REFUSAL };
      const before = editSession.timeline;
      runningTools.set(name, (runningTools.get(name) ?? 0) + 1);
      try {
        const output = await execute.apply(this ?? tool, args) as { staged?: unknown } | undefined;
        if (output?.staged === true) stagedTools.add(name);
        if (tracksChanges() && name !== 'createTimeline' && name !== 'openTimeline' && before !== editSession.timeline) {
          const clip = input.clipId ? editSession.timeline.clips.find(clip => clip.id === input.clipId) : undefined;
          const moments = clip?.scene && input.scope !== undefined ? resolveScope(editSession.timeline, clip, input.scope).map(range => timelineTimeAtSource(clip, (range.start + range.end) / 2)) : recipe().frames === 'sample' ? fastReelFrameMoments(name, before, editSession.timeline) : undefined;
          fastReview.changed(before, editSession.timeline, moments);
          return { ...output, pendingFrameTimes: fastReview.times() };
        }
        return output;
      } finally {
        const left = (runningTools.get(name) ?? 1) - 1;
        if (left) runningTools.set(name, left); else runningTools.delete(name);
      }
    };
  }
  // Every editing tool takes the approved-work override. Background jobs (cut-outs, upscales, slow motion) apply
  // later, outside this check, so they refuse an approved clip up front.
  const appliedLater = new Set(['removeBackground', 'upscaleClip', 'smoothSlowMotion']);
  for (const [name, tool] of Object.entries(tools as Record<string, { execute?: (...args: never[]) => Promise<unknown>; inputSchema?: unknown }>)) {
    const execute = tool.execute;
    if (APPROVAL_FREE_TOOLS.has(name) || !execute || !(tool.inputSchema instanceof z.ZodObject)) continue;
    tool.inputSchema = tool.inputSchema.extend({ overrideApproved: z.union([z.boolean(), z.enum(['true', 'false'])]).optional().describe('Only when the user asked for this exact change to approved work: edit it anyway. Needs overrideReason.'), overrideReason: z.string().trim().min(3).max(300).optional().describe("What the user asked, quoted, when overrideApproved is true.") });
    tool.execute = async function (this: unknown, ...args: never[]) {
      // Clients holding an older tool list send the flag as a string.
      const { overrideApproved: flag, overrideReason, ...input } = (args[0] ?? {}) as Record<string, unknown> & { overrideApproved?: boolean | string; overrideReason?: string };
      const overrideApproved = flag === true || flag === 'true';
      args = [input, ...args.slice(1)] as never[];
      if (overrideApproved && !overrideReason) throw new Error('overrideApproved needs overrideReason: quote what the user asked. Nothing was changed.');
      if (!overrideApproved && appliedLater.has(name) && typeof input.clipId === 'string') {
        await editSession.wait();
        const clip = editSession.timeline.clips.find(item => item.id === input.clipId);
        if (clip && isApproved(clip)) throw new Error(approvalRefusal([{ clipId: clip.id, name: clip.scene?.title || clip.kind, what: 'replace its media', note: clip.approval?.note ?? clip.approvedSections?.[0]?.note }]));
      }
      if (!overrideApproved) return execute.apply(this ?? tool, args);
      approvalOverride.active++; approvalOverride.reason = overrideReason!;
      const from = approvalOverride.overridden.length;
      try {
        const output = await execute.apply(this ?? tool, args);
        const overridden = approvalOverride.overridden.slice(from);
        return overridden.length && output && typeof output === 'object' ? { ...output, approvedOverridden: { reason: overrideReason, clips: overridden.map(item => ({ clipId: item.clipId, name: item.name, change: item.what })) }, note: 'Approved work was changed because the user asked. Say so in your reply; it stays approved.' } : output;
      } finally { approvalOverride.active--; }
    };
  }
  assertToolDefinitions(tools);
  // Capture actual writes after every preflight/wrapper, for both server runtimes and MCP.
  for (const [name, tool] of Object.entries(tools as Record<string, { execute?: (...args: never[]) => Promise<unknown>; toModelOutput?: (...args: never[]) => unknown }>)) {
    const execute = tool.execute;
    if (!execute) continue;
    tool.execute = function (this: unknown, ...args: never[]) {
      const instance = this && typeof this === 'object' ? this : tool;
      const supplied = 'ctx' in instance && instance.ctx && typeof instance.ctx === 'object' ? instance.ctx : {};
      const bound = { ...instance, ctx: { ...supplied, ...ctx } };
      const call=z.object({toolCallId:z.string().optional()}).parse(args[1]??{});
      return receipts.execute(name, () => editSession.revision, () => execute.apply(bound, args), async () => {
        const before=editSession.timeline;
        await editSession.reconcileSaved(() => ctx.runQuery(internal.assistant.getRunTimeline, run),true);
        if(tracksChanges())fastReview.changed(before,editSession.timeline);
      },call.toolCallId);
    };
    const serialize = tool.toModelOutput;
    if (!serialize) continue;
    tool.toModelOutput = async function (this: unknown, ...args: never[]) {
      const { output } = z.object({ output: z.record(z.string(), z.unknown()) }).parse(args[0]);
      const receipt = toolSaveReceipt(output);
      if (!receipt) return serialize.apply(this ?? tool, args);
      const envelope = { saveReceipt: receipt, saved: output.saved, unchanged: output.unchanged, staged: output.staged, revision: receipt.revision };
      if (output.success === false || output.error || output.isError === true) {
        const { images: _images, ...result } = output;
        return { type: 'json', value: result };
      }
      try {
        const rendered = z.object({ type: z.string(), value: z.unknown() }).parse(await serialize.apply(this ?? tool, args));
        if (rendered.type === 'content' && Array.isArray(rendered.value)) return { ...rendered, value: [...rendered.value, { type: 'text', text: JSON.stringify(envelope) }] };
        if (rendered.type === 'json') return { ...rendered, value: { ...z.record(z.string(), z.unknown()).parse(rendered.value), ...envelope } };
        return { type: 'json', value: { result: rendered.value, ...envelope } };
      } catch {
        const { images: _images, ...result } = output;
        return { type: 'json', value: { ...result, previewUnavailable: true, note: 'The tool result is recorded, but its preview could not be attached.' } };
      }
    };
  }
  // Observe the final receipt, including every wrapper above, in both server runtimes and MCP.
  for (const [name, tool] of Object.entries(tools as Record<string, { execute?: (...args: never[]) => Promise<unknown> }>)) {
    const execute = tool.execute;
    if (!execute || !needsSaveConfirmation(name)) continue;
    tool.execute = async function (this: unknown, ...args: never[]) {
      const revisionBefore = editSession.revision;
      const output = await execute.apply(this ?? tool, args);
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const evidence = z.object({ saved: z.unknown().optional(), unchanged: z.unknown().optional(), staged: z.unknown().optional(), revision: z.unknown().optional(), success: z.unknown().optional(), error: z.unknown().optional(), isError: z.unknown().optional() }).parse(output);
        if (evidence.success === false || evidence.error || evidence.isError === true || (evidence.staged !== true && hasSaveEvidence(evidence))) return output;
        const call = z.object({ toolCallId: z.string().optional() }).safeParse(args[1] ?? {});
        const observation = {
          ...run, ...options.publication, ...(project.threadId && !options.publication ? { threadId: project.threadId } : {}),
          source: options.publication ? 'editor' as const : 'mcp' as const, toolName: name, toolCallId: (call.success ? call.data.toolCallId : undefined) ?? crypto.randomUUID(),
          inputShape: incidentShape(args[0]), outputShape: incidentShape(output), revisionBefore, revisionAfter: editSession.revision,
          staged: evidence.staged === true, ...(typeof evidence.revision === 'number' && Number.isSafeInteger(evidence.revision) ? { stagedRevision: evidence.revision } : {}),
          observedAt: Date.now(),
        };
        // Reuse the call identity after a dropped response so a committed write is not counted twice.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await ctx.runMutation(internal.saveIncidents.observe, observation); break; }
          catch {
            // Diagnostics must never turn a saved edit into a tool failure. No raw payload is logged.
            if (attempt === 2) console.warn(`[save-incidents] ${JSON.stringify({ event: 'observation-failed', runId: run.runId, toolName: name })}`);
          }
        }
      }
      return output;
    };
  }
  // Reports include failed edits and all timed exceptions, after the save receipt is settled.
  for (const [name, tool] of Object.entries(tools as Record<string, { execute?: (...args: never[]) => Promise<unknown> }>)) {
    const execute = tool.execute;
    if (!execute) continue;
    tool.execute = async function (this: unknown, ...args: never[]) {
      let output: unknown;
      try { output = await execute.apply(this ?? tool, args); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const data = error && typeof error === 'object' && 'data' in error ? error.data as { status?: string; message?: string } : undefined;
        if (data?.status !== 'still_queued' && !message.includes('Still queued after')) throw error;
        output = { success: false, checkPassed: false, status: 'still_queued', error: data?.message ?? message, retryAfterSeconds: 30, nextAction: { tool: name, arguments: { projectId: run.projectId, ...((args[0] ?? {}) as Record<string, unknown>) } } };
      }
      if (referenceMotionEnabled() && (toolBehavior(name)?.effect === 'timeline' || (output as { status?: string })?.status === 'still_queued') && (referenceAssetId() || editSession.timeline.clips.some(clip => clip.scene?.film?.referenceAssetId))) {
        try { return { ...(output as Record<string, unknown>), ...await motionStatus() }; }
        catch { return { ...(output as Record<string, unknown>), motionCheck: 'motionMap: state unavailable; this check has not passed. Retry motionMap or mark an unmeasurable window OFF with its time and reason.' }; }
      }
      return output;
    };
  }
  // A film still streaming in as addFilm or patchScene input, cut to its finished sections (lib/editor/film-draft.ts).
  // Nothing here is saved to the timeline: the editor shows it from its own draft row until the call lands.
  const buildFilmDraft:BuildFilmDraft=async(tool,input,memo)=>{
    const timeline=editSession.timeline,num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
    if(tool==='addFilm'){
      const title=typeof input.title==='string'&&input.title.trim()?input.title.trim().slice(0,SCENE_LIMITS.title):'Film',code=typeof input.code==='string'?input.code:'';
      const beats=(Array.isArray(input.sections)?input.sections:[]).flatMap(item=>{const beat=item as {title?:unknown;at?:unknown};return typeof beat?.title==='string'&&num(beat.at)!==undefined?[{title:beat.title,at:num(beat.at)!}]:[];}).sort((a,b)=>a.at-b.at);
      // Beat-timed section()/shot() headers resolve against this timeline's markers first, so the parser sees literals.
      const draftStart=num(input.start)??0,timing=code?resolveBeatTiming(code,newFilmBeats(timeline,draftStart,num(input.duration)??180),false):{code:'',resolved:[]};
      const cut=code?cutFilmDraft(timing.code):{sections:[] as DraftSection[]};
      if(cut.code)memo.code=cut.code;
      const good=typeof memo.code==='string'?memo.code:undefined,shown=good?draftSections(good):[];
      const ends=[...shown,...cut.writing?[cut.writing]:[]].map(item=>item.start+item.duration);
      const duration=Math.min(180,num(input.duration)??Math.max(1,...ends,...beats.map(beat=>beat.at+1)));
      const planned=beats.map((beat,index)=>({title:beat.title,start:beat.at,duration:Math.max(.1,(beats[index+1]?.at??duration)-beat.at)})).filter(item=>![...shown,...cut.writing?[cut.writing]:[]].some(done=>Math.abs(done.start-item.start)<1e-3||done.title.trim().toLowerCase()===item.title.trim().toLowerCase()));
      let clip:Clip|undefined;
      if(good){
        if(memo.extras===undefined){
          const brandKitId=typeof input.brandKitId==='string'?input.brandKitId:undefined,names=Array.isArray(input.blueprints)?input.blueprints.filter((name):name is string=>typeof name==='string'):[];
          const brand=brandKitId?await sceneBrandSnapshot(ctx,run.ownerId,brandKitId).catch(()=>undefined):undefined;
          let media:{name:string;assetId:string}[]|undefined;try{media=Array.isArray(input.media)?sceneMedia(input.media as {name:string;assetId:string}[]):undefined;}catch{media=undefined;}
          const blueprints=names.length?await sceneBlueprints(brandKitId,names).catch(()=>undefined):undefined;
          memo.extras={...(brand?{brand}:{}),...(media?.length?{media}:{}),...(blueprints?.length?{blueprints}:{})};
        }
        try{clip=placeFilm(timeline,{id:'film-draft',title,start:num(input.start)??0,duration,track:num(input.track),scene:{code:good,...memo.extras as object}}).timeline.clips.find(item=>item.id==='film-draft');}catch{clip=undefined;}
      }
      return {timelineId,tool,title,start:num(input.start)??0,duration,...(clip?{clip}:{}),sections:shown,...(cut.writing?{writing:cut.writing}:{}),planned};
    }
    const target=typeof input.clipId==='string'?timeline.clips.find(item=>item.id===input.clipId):undefined;
    if(!target?.scene)return undefined;
    const edits=Array.isArray(input.edits)?input.edits as Record<string,unknown>[]:[],ready:(SceneEdit|SceneLineEdit)[]=[];
    let writing:DraftSection|undefined;
    const beats=clipBeats(timeline,target);
    for(const [index,edit] of edits.entries()){
      if(!edit||typeof edit!=='object'||typeof edit.replace!=='string')continue;
      let replace=edit.replace;
      // The edit still streaming keeps only the sections it has finished.
      replace=resolveBeatTiming(replace,beats,false).code;
      if(index===edits.length-1){const cut=cutDraftSnippet(replace);writing=cut.writing;if(cut.text===undefined)continue;replace=cut.text;}
      const insert:{insert?:'before'|'after'}=edit.insert==='before'||edit.insert==='after'?{insert:edit.insert}:{};
      const lines=edit.lines as {start?:unknown;end?:unknown}|undefined;
      if(typeof edit.find==='string'&&edit.find)ready.push({find:edit.find,replace,...(edit.all===true?{all:true}:{}),...insert});
      else if(num(lines?.start)!==undefined&&num(lines?.end)!==undefined)ready.push({lines:{start:num(lines!.start)!,end:num(lines!.end)!},replace,...insert});
    }
    if(ready.length&&memo.edits!==JSON.stringify(ready)){
      memo.edits=JSON.stringify(ready);
      try{const code=patchSceneCode(timeline,target,ready,{section:typeof input.section==='string'?input.section:undefined}).code;checkSceneCode(code);memo.code=code;}catch{/* Keep the last good cut. */}
    }
    const good=typeof memo.code==='string'?memo.code:undefined;
    const {codeRef:_codeRef,...scene}=target.scene;
    return {timelineId,tool,title:scene.title,start:target.start-target.sourceStart/(target.playbackRate??1),duration:target.scene.film?.duration??target.duration,...(good?{clip:{...target,scene:{...scene,code:good}}}:{}),sections:good?draftSections(good):[],...(writing?{writing}:{}),planned:[]};
  };
  const filmDrafts=filmDraftPublisher({build:buildFilmDraft,write:draft=>ctx.runMutation(internal.filmDrafts.publish,{...run,draft}),clear:()=>ctx.runMutation(internal.filmDrafts.clear,run)});
  const availableToolNames=():string[]=>Object.keys(tools).filter(name=>(mcpSurface||!MCP_ONLY_TOOLS.has(name))&&laneToolAllowed(lane,name,[...capabilities]));
  for(const [name,tool] of Object.entries(tools) as [string,{execute?:(...args:never[])=>Promise<unknown>}][]){
    const execute=tool.execute;if(!execute)continue;
    tool.execute=async function(this:unknown,...args:never[]){
      // The saved film takes over from the live draft once addFilm or patchScene lands or fails.
      if(DRAFT_TOOLS.includes(name)){try{return await invoke.call(this,...args);}finally{await filmDrafts.landed();}}
      return invoke.call(this,...args);
    };
    const invoke=async function(this:unknown,...args:never[]){
      // Genesis and other MCP-only tools never run for Revline's in-app agent, whatever its lane or capabilities.
      if(MCP_ONLY_TOOLS.has(name)&&!mcpSurface)throw new Error(`Tool "${name}" is not a Revline editing tool.`);
      if(!laneToolAllowed(lane,name,[...capabilities]))throw new Error(laneToolError(lane,name));
      const input=(args[0]??{}) as Record<string,unknown>;
      if(name==='analyzeMedia'){
        const mode=String(input.mode),allowed=mode==='transcribe'||mode==='shots'||mode==='beats'||['track','facecam','speakers'].includes(mode)||(lane==='recreate'||capabilities.has('recreate')||capabilities.has('remaking-videos'))&&mode==='reference';
        if(!allowed)throw new Error(`Analysis mode ${mode} is unavailable in the ${lane} lane. Use saved transcript/audio/shot signals, or loadCapability for reference work.`);
      }
      if(name==='readFrames'&&lane==='recreate'&&input.fps!==undefined){
        const asset=assets.find(asset=>asset._id===input.assetId),fps=sourceFrameRates.get(String(input.assetId))??asset?.analysis?.shots?.fps;
        if(fps&&Number(input.fps)<fps)throw new Error(`Recreation frame windows require full source fps (${fps}).`);
      }
      if(taskId){
        const task=await laneCtx.runQuery(internal.lanes.task,taskScope) as LaneTask|null;
        if(name==='exportVideo'&&!task?.exportConfirmed)throw new Error('Export needs explicit user confirmation in the current request. Ask the user before exporting.');
        if(task?.result?.exhausted)throw exhaustedLaneError(lane,task.result.failures.join(' '));
        if(tracksChanges()&&task){
          const saved=readFastFrameTimes(task.evidence,timelineId,await timelineHistoryKey(editSession.timeline));
          if(saved!==undefined)fastReview.restore(saved);
        }
        await ensureBaseline();
      }
      noteToolIntent(name);
      if(taskId&&finishRequired&&!requiredPersisted){await laneCtx.runMutation(internal.lanes.requireFinish,taskScope);requiredPersisted=true;}
      const before=await timelineHistoryKey(editSession.timeline);
      const output=await execute.apply(this??tool,args) as Record<string,unknown>;
      const after=await timelineHistoryKey(editSession.timeline);
      if(before!==after||name==='createTimeline'||name==='openTimeline'||referenceMotionEnabled()&&['motionMap','compareMotion','compareReference'].includes(name))finishResult=undefined;
      if(taskId&&tracksChanges()&&(before!==after||name==='getFrames'||name==='finish'))
        await laneCtx.runMutation(internal.lanes.evidence,{...taskScope,evidence:fastFrameEvidence(timelineId,after,fastReview.times())});
      if(taskId&&['compareReference','compareMotion','checkPacing','checkSound'].includes(name)&&output?.success!==false&&before===after&&(name!=='compareReference'||(typeof output.samples==='number'&&output.samples>0&&output.sourceFingerprint===after&&output.revision===editSession.revision))){
        const {images:_images,...evidence}=output;
        await laneCtx.runMutation(internal.lanes.evidence,{...taskScope,evidence:{tool:name,timelineId,fingerprint:after,input,output:evidence}});
      }
      return output;
    };
  }
  // Revline's in-app agent is never handed MCP-only tools (Genesis), not even inactive definitions.
  if(!mcpSurface)for(const name of MCP_ONLY_TOOLS)delete (tools as Record<string,unknown>)[name];
  return { tools, filmDrafts, editSession, motionStatus, lane:()=>lane, laneChosen:()=>laneChosen, requiresFinish:()=>finishRequired, noteToolIntent, availableToolNames, laneFinished:()=>!!finishResult?.passed, laneFailure:()=>finishResult, publicationResult: async (output: unknown) => ({ ...receipts.publishedResult(output, editSession.revision), ...await motionStatus() }), plans: () => effectPlans, checkLevel: () => checkLevel, recipe, pendingFastFrames: () => fastReview.times(), clippingState:()=>ctx.runQuery(internal.clipping.completionState,{...clippingRun,timeline:editSession.timeline,timelineId:clippingTimelineId}),fastReviewFeedback: () => !clippingActive&&tracksChanges() ? fastReview.feedback() : undefined };
}
