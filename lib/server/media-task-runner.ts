import { materializeTranscript } from '../media-analysis/transcript';
import { exportChunkResources } from '../export-chunk-resources.mjs';
import { checkClipSnapshot } from './check-clip';
import { FrameCache } from './frame-cache';
import { referenceResultDescriptor, snapshotResultDescriptor, cacheHash } from '../media-analysis/frame-cache';
import { importCheckpoint } from './import-checkpoint';
import { findSourceHighlights } from './find-highlights';
import { readHighlights } from '../media-analysis/highlights';
import { downloadOwnedMedia, ownedMediaUrl } from './owned-media';
import { api as pixelTrackApi } from '../../convex/_generated/api';
import { trackSourcePixels } from './track-source-pixels';
import { MAX_SPEAKER_WINDOW_SECONDS, SPEAKER_ANALYSIS_VERSION, speakerAnalysis } from '../media-analysis/clipping';
import { audioNormalizationKey, timelineNormalizationKey } from '../editor/audio-normalization';
import { normalizeTimelineAudio, enforceNormalizedExportPeak } from './normalize-audio';
import { detectSourceFacecam, trackSourceSpeakers } from './clipping-analysis';
import type { ExportResolution } from '@/lib/editor/composition';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConvexHttpClient } from 'convex/browser';
import type { MediaWorkItem, MediaTaskResult } from '@/convex/lib/media_task_contract';
import { dimensions, timelineDuration, type MediaAsset } from '@/lib/editor/types';
import { extractTranscriptionAudio, extractVideoWindow, needsAnalysisVideoProxy, prepareVideo, probeMedia } from '@/lib/server/analysis-video';
import { breakDownReference, inspectVideo, inspectVideoFrames, understandVideo } from '@/lib/media-analysis/gemini';
import { MAX_REFERENCE_SECONDS, MAX_REFERENCE_SHOTS, readReference as readBreakdown, referenceKeyframes } from '@/lib/media-analysis/reference';
import { transcribeWithDeepgram } from '@/lib/media-analysis/deepgram';
import { currentTranscript, type Transcript } from '@/lib/media-analysis/transcript';
import { detectShots } from '@/lib/server/detect-shots';
import { detectMusicBeats } from '@/lib/server/music-beats';
import { AnalysisError, isRetryableAnalysisError } from '@/lib/media-analysis/errors';
import { trackSourceFace } from './track-source-face';
import { readReference, videoMoments } from './read-reference';
import { runBlueprintCheck } from './blueprint-check';
import { extractSourceAudio } from './extract-audio';
import { measureAudioWaveform } from './audio-waveform';
import { measureAudioActivity } from './measure-audio-activity';
import { mediaSourceCacheIdentity, reuseCachedMediaFile, reuseMediaFile } from './media-file-cache';
import { uploadMediaFile, type UploadContext } from './upload-media-file';
import { identifyPlayback, prepareTimelinePlayback, publishPlaybackPoster } from './prepare-playback';
import { runDistributedRender, runRenderWorker } from './render-worker';
import { importVideoLink } from './import-video-link';
import { removeBackground } from './remove-background';
import { deriveMedia, measureColor } from './derive-media';
import { runGenesisJob } from '../ai/lanes/genesis/worker/run';
import { prepareComposition,writeComposition } from './prepare-composition';
import { renderPlainExport } from './plain-export-render';
import { plainExportPlan } from '@/lib/editor/plain-export';
import { captureTimelineFrames, reviewComposition } from './review-composition';
import { readCompare } from './read-compare';
import { extractInspectionFrames, extractReferenceKeyframes } from './inspect-video-frames';
import { measureSpeechCleanup } from './speech-cleanup-analysis';
import { currentSpeechCleanup } from '@/lib/speech-cleanup';
import { MEDIA_ACTIVITY_LABELS, type MediaTaskActivity, type ReportMediaActivity } from '@/lib/media-analysis/activity';

export async function processMediaTask(task: MediaWorkItem, convex: ConvexHttpClient, convexUrl: string, signal: AbortSignal, onProgress: (percent: number) => void, onActivity?: ReportMediaActivity, exclusive?: UploadContext['exclusive']): Promise<MediaTaskResult> {
  task={...task,...(task.asset?{asset:materializeTranscript(task.asset)}:{}),...(task.transcriptionAsset?{transcriptionAsset:materializeTranscript(task.transcriptionAsset)}:{}),...(task.snapshot?{snapshot:{...task.snapshot,assets:task.snapshot.assets.map(materializeTranscript)}}:{}),...(task.render?{render:{...task.render,assets:task.render.assets.map(materializeTranscript)}}:{}),...(task.review?{review:{...task.review,assets:task.review.assets.map(materializeTranscript)}}:{})};
  const startedAt = Date.now();
  const parentSignal = signal;
  const speechBudget = Math.min(900_000, Math.max(180_000, Math.ceil((task.asset?.duration ?? 600) * 1000)));
  const speechDeadline = task.kind === 'transcribe' ? AbortSignal.timeout(speechBudget) : undefined;
  if (speechDeadline) signal = AbortSignal.any([signal, speechDeadline]);
  const logPhase = (phase: string, state: string, phaseStartedAt: number, detail = '') => {
    const now = Date.now();
    console.log(`[${new Date(now).toISOString()}] Media task ${task.taskId} (${task.kind}): ${phase} ${state}${detail ? ` · ${detail}` : ''} · phase ${((now - phaseStartedAt) / 1000).toFixed(1)}s · total ${((now - startedAt) / 1000).toFixed(1)}s · chat ${task.projectId}${task.aiRunId ? ` · run ${task.aiRunId}` : ''}`);
  };
  const runPhase = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const phaseStartedAt = Date.now();
    logPhase(phase, 'started', phaseStartedAt);
    const heartbeat=setInterval(()=>logPhase(phase,'still running',phaseStartedAt),15_000);
    try {
      const result = await work();
      logPhase(phase, 'complete', phaseStartedAt);
      return result;
    } catch (error) { logPhase(phase, 'failed', phaseStartedAt); throw error; }
    finally { clearInterval(heartbeat); }
  };
  let geminiActivity:MediaTaskActivity|undefined,geminiActivityStartedAt=0,geminiHeartbeat:ReturnType<typeof setInterval>|undefined;
  const reportGeminiActivity:ReportMediaActivity=(activity,diagnostic)=>{
    if(diagnostic)logPhase('Video evidence validation','rejected',geminiActivityStartedAt||startedAt,JSON.stringify(diagnostic));
    if(activity===geminiActivity)return;
    if(geminiActivity)logPhase(MEDIA_ACTIVITY_LABELS[geminiActivity],'complete',geminiActivityStartedAt);
    clearInterval(geminiHeartbeat);geminiActivity=activity;geminiActivityStartedAt=Date.now();
    onActivity?.(activity);logPhase(MEDIA_ACTIVITY_LABELS[activity],'started',geminiActivityStartedAt);
    geminiHeartbeat=setInterval(()=>logPhase(MEDIA_ACTIVITY_LABELS[activity],'still running',geminiActivityStartedAt),15_000);
  };
  const checkpoint = task.kind === 'import' ? await importCheckpoint(convexUrl, task.taskId) : undefined;
  const directory = checkpoint?.directory ?? await mkdtemp(join(tmpdir(), 'revline-task-'));
  let completed = false;
  const credentials = { taskId: task.taskId, leaseToken: task.leaseToken };
  const uploadContext: UploadContext = { convex, refreshAuth: async () => { signal.throwIfAborted(); }, exclusive };
  try {
    if (task.kind === 'import') {
      if (task.outputAssetId) { completed = true; return {}; }
      if (!task.sourceUrl) throw new AnalysisError('The video link is missing.', 400);
      const { path, ...metadata } = await importVideoLink(task.sourceUrl, directory, signal, onProgress, task.importRange);
      await uploadMediaFile(path, { ...credentials, projectId: task.projectId, ...metadata, kind: 'video', contentType: 'video/mp4' }, uploadContext, signal);
      completed = true;
      onProgress(98);
      return {};
    }
    if (task.kind === 'render') {
      if (!task.render || !task.renderJobId) throw new AnalysisError('Export snapshot is missing.', 400);
      if (task.outputStored) return {};
      const snapshot = task.render;
      onProgress(1);
      const {assetUrls,audioSourceOffsets}=await runPhase('Preparing export media',()=>prepareComposition(directory,snapshot.timeline,snapshot.assets as (MediaAsset & {size:number})[],convexUrl,signal));
      onProgress(3);
      const output = join(directory, 'video.mp4'), quality = snapshot.quality as 'draft' | 'standard' | 'high';
      // Report monotonically; a fast-path fallback maps the browser render onto the remaining range.
      let reported = 0, base = 5, span = 90;
      const renderProgress = (progress: { progress: number }) => { reported = Math.max(reported, base + Math.round(progress.progress / 100 * span)); onProgress(reported); };
      // Plain video/audio timelines skip browser compositing. REVLINE_RENDER_FAST_PATH=0 disables it.
      const decision = process.env.REVLINE_RENDER_FAST_PATH === '0' ? { eligible: false as const, reason: 'disabled by REVLINE_RENDER_FAST_PATH=0' } : plainExportPlan(snapshot.timeline, snapshot.assets as MediaAsset[], snapshot.resolution as ExportResolution, snapshot.fps);
      let rendered = false;
      if (decision.eligible) {
        try {
          await runPhase('Rendering export with FFmpeg', () => renderPlainExport(directory, output, decision.plan, assetUrls, audioSourceOffsets, quality, renderProgress, signal));
          rendered = true;
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn(`Media task ${task.taskId}: FFmpeg export failed; falling back to the browser renderer.`, error instanceof Error ? error.message : error);
          await rm(output, { force: true });
          base = Math.max(5, reported); span = 95 - base;
        }
      } else logPhase('FFmpeg export', 'skipped', Date.now(), decision.reason);
      // Only the browser renderer reads the HTML composition.
      if (!rendered) await runPhase('Preparing export composition',()=>writeComposition(directory,snapshot.timeline,snapshot.assets as (MediaAsset & {size:number})[],assetUrls,snapshot.resolution as ExportResolution,snapshot.fps as 24|30|60,'./',signal,audioSourceOffsets));
      // Hosted export workers split the render across parallel chunk machines (REVLINE_DISTRIBUTED_EXPORT).
      const distributed = process.env.REVLINE_DISTRIBUTED_EXPORT === 'true' ? { maxChunks: Number(process.env.REVLINE_EXPORT_MAX_CHUNKS ?? 8), ...exportChunkResources({ guest: process.env.REVLINE_EXPORT_CHUNK_GUEST ? JSON.parse(process.env.REVLINE_EXPORT_CHUNK_GUEST) : undefined, env: process.env.REVLINE_EXPORT_CHUNK_ENV ? JSON.parse(process.env.REVLINE_EXPORT_CHUNK_ENV) : undefined }) } : null;
      if (!rendered && distributed) await runPhase('Rendering export across machines',()=>runDistributedRender(directory, output, { fps: snapshot.fps, quality, ...dimensions(snapshot.timeline.aspectRatio, snapshot.resolution as ExportResolution), exportId: task.taskId, ...distributed }, renderProgress, signal));
      else if (!rendered) await runPhase('Rendering export',()=>runRenderWorker(directory, output, { fps: snapshot.fps, quality }, renderProgress, signal));
      const normalized=snapshot.timeline.clips.filter(c=>c.normalizedAudio&&c.normalizedAudio.key===audioNormalizationKey(snapshot.timeline,c)&&(c.volume??1)>0);
      const master=snapshot.timeline.audioNormalization,ceilings=normalized.flatMap(c=>c.normalizedAudio?[c.normalizedAudio.truePeak]:[]);
      if(master?.key===timelineNormalizationKey(snapshot.timeline))ceilings.push(master.truePeak);
      if(ceilings.length)await runPhase('Verifying encoded true peak',()=>enforceNormalizedExportPeak(output,directory,Math.min(...ceilings),signal));
      onProgress(97);
      await runPhase('Uploading export',()=>uploadMediaFile(output, { ...credentials, jobId: task.renderJobId, projectId: task.projectId, fileName: 'video.mp4', contentType: 'video/mp4', kind: 'video', duration: timelineDuration(snapshot.timeline), ...dimensions(snapshot.timeline.aspectRatio, snapshot.resolution) }, uploadContext, signal));
      return {};
    }
    if(task.kind==='review'){if(!task.review)throw new AnalysisError('Review snapshot is unavailable.',400);return {review:await reviewComposition(task.review,directory,convexUrl,signal,onProgress)};}
    if(task.kind==='blueprint'){if(!task.blueprint)throw new AnalysisError('The blueprint check is unavailable.',400);return {blueprint:await runBlueprintCheck(task.blueprint,signal,onProgress)};}
    if(task.kind==='snapshot'&&task.snapshot?.clipCheck){
      const snapshot=task.snapshot,cache=snapshot.cacheIdentity?new FrameCache(convex,credentials,signal):undefined;
      const produce=()=>runPhase('Checking clip',()=>checkClipSnapshot(snapshot,directory,convexUrl,signal,onProgress,cache));
      // Complete check results survive a lease handoff after decoding/sampling.
      // Scope, overrides, immutable timeline and source evidence all bind reuse.
      const descriptor={kind:'clip-check-result',version:1,identity:snapshot.cacheIdentity,request:snapshot.clipCheck,
        evidence:await cacheHash(snapshot.assets.map(asset=>[asset._id,asset.analysis]))};
      return {snapshot:cache?await cache.json(descriptor,produce):await produce()};
    }
    if(task.kind==='snapshot'&&task.snapshot?.normalization){
      const {path,...measurements}=await runPhase('Normalizing loudness',()=>normalizeTimelineAudio(task.snapshot!,directory,convexUrl,signal));
      onProgress(90);
      const assetId=task.outputAssetId??await uploadMediaFile(path,{...credentials,projectId:task.projectId,fileName:'Normalized social mix.wav',kind:'audio',contentType:'audio/wav',duration:measurements.duration},uploadContext,signal);
      if(!assetId)throw new AnalysisError('The normalized audio could not be saved.',500);
      return {snapshot:{frames:[],normalization:{assetId,...measurements}}};
    }
    if(task.kind==='snapshot'){
      if(!task.snapshot)throw new AnalysisError('The frame request is unavailable.',400);
      const snapshot=task.snapshot,cache=snapshot.cacheIdentity?new FrameCache(convex,credentials,signal):undefined;
      const produce=()=>captureTimelineFrames(snapshot,directory,convexUrl,signal,onProgress,cache);
      return {snapshot:cache?await cache.json(snapshotResultDescriptor(snapshot.cacheIdentity!,snapshot.times),produce):await produce()};
    }
    const asset = task.asset;
    if (!asset?.url) throw new AnalysisError('The source media is unavailable.', 400);
    if(task.kind==='preview'&&asset.kind==='video'&&asset.previewVersion===1&&asset.previewR2Key&&[asset.previewSize,asset.previewWidth,asset.previewHeight,asset.previewFps].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0))return {};
    if (task.kind === 'extract' && asset.audioExtracted) return asset.audioAssetId ? { audioAssetId: asset.audioAssetId } : {};
    if (task.kind === 'waveform' && asset.waveform) return { waveform: asset.waveform };
    if (task.kind === 'highlights' && readHighlights(asset.analysis?.highlights)?.judge==='gemini' && (!task.highlightSourceType || readHighlights(asset.analysis?.highlights)?.sourceType===task.highlightSourceType)) return {analysis:{highlights:asset.analysis!.highlights}};
    if (task.kind === 'transcribe' && asset.kind === 'video' && asset.audioExtracted && !asset.audioAssetId) throw new AnalysisError('This source has no audio to transcribe.', 400);
    if (task.kind === 'transcribe' && currentTranscript(asset.analysis?.transcript) && asset.analysis?.audioActivity && currentSpeechCleanup(asset.analysis.speechCleanup)) return { analysis: { transcript: asset.analysis.transcript, audioActivity: asset.analysis.audioActivity, speechCleanup: asset.analysis.speechCleanup } };
    if (task.kind === 'understand' && asset.analysis?.understanding) return { analysis: { understanding: asset.analysis.understanding } };
    // A breakdown saved before moments were measured only needs its moments; the model pass stays.
    if (task.kind === 'reference' && readBreakdown(asset.analysis?.reference)?.moments) return { analysis: { reference: asset.analysis!.reference } };
    const sourceAsset = task.kind === 'transcribe' ? task.transcriptionAsset ?? asset : asset;
    if (!sourceAsset.url) throw new AnalysisError('The prepared source media is unavailable.', 400);
    // Footage questions read the stored 1280px playback preview when it exists:
    // originals reach hundreds of MB, and downloading and re-encoding one took
    // minutes before Gemini could start. The preview keeps every frame and audio.
    // Speaker cuts must retain native PTS; older previews may have rounded the frame clock.
    // A passthrough preview is the same immutable source, so keep its source
    // cache identity instead of downloading a second copy for Gemini.
    const preview = (task.kind === 'highlights' || task.kind === 'video' || task.kind === 'understand' || task.kind === 'reference') && asset.kind === 'video' && asset.previewUrl && asset.previewR2Key !== asset.r2Key && asset.previewVersion === 1 && (task.kind !== 'highlights' || asset.previewSize! < sourceAsset.size) && [asset.previewSize, asset.previewWidth, asset.previewHeight].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      ? { url: asset.previewUrl, size: asset.previewSize!, width: asset.previewWidth!, height: asset.previewHeight!, contentType: 'video/mp4' } : undefined;
    const download = preview ?? { url: sourceAsset.url, size: sourceAsset.size, width: sourceAsset.width, height: sourceAsset.height, contentType: sourceAsset.contentType };
    const audioOnly = ['extract', 'waveform', 'transcribe', 'beats'].includes(task.kind);
    const rangeRead = (sourceAsset.kind === 'video' && (task.kind === 'read' && task.read?.mode !== 'track' || task.kind === 'frames' || task.kind === 'derive' || task.kind === 'cutout' || task.kind === 'genesis'));
    const localSource = join(directory, 'source'), sourceUrl = download.url;
    let source = rangeRead ? ownedMediaUrl(download.url, new URL(convexUrl).origin) : localSource;
    const cacheIdentity = mediaSourceCacheIdentity(convexUrl, task.projectId, sourceAsset);
    // Playback preparation may already hold the whole immutable VOD. Range
    // reads and audio extraction reuse it rather than stream it from R2 again.
    const reusedRangeSource = rangeRead && await reuseCachedMediaFile({ identity: cacheIdentity, variant: 'source-v1', target: localSource, signal, expectedBytes: download.size });
    if (reusedRangeSource) source = localSource;
    let posterReady=!!asset.thumbnailStorageId;
    if(task.kind==='preview'){
      try{await publishPlaybackPoster(sourceUrl,directory,task,uploadContext,signal);posterReady=true;}catch(error){if(signal.aborted)throw error;}
      try{await identifyPlayback(sourceUrl,task,uploadContext,signal);}catch(error){if(signal.aborted)throw error;}
    }
    const downloadStartedAt = Date.now();
    let loggedPercent = 0, loggedAt = downloadStartedAt;
    const reusedSource = rangeRead ? reusedRangeSource : await reuseMediaFile({ identity: cacheIdentity, variant: preview ? 'preview-file-v1' : 'source-v1', target: source, signal, expectedBytes: download.size }, () => {onActivity?.('downloading');return runPhase(preview ? 'Downloading playback preview' : 'Downloading source', () => downloadOwnedMedia(sourceUrl, source, new URL(convexUrl).origin, download.size, signal, {
      concurrency: audioOnly || task.kind === 'highlights' ? 3 : 1,
      ...(audioOnly ? { reserveBytes: 256 * 1024 * 1024 + Math.min(download.size, Math.ceil((sourceAsset.duration ?? 3600) * 256000)) } : {}),
      onProgress: (bytes, total) => {
        const percent = Math.floor(bytes / total * 100), now = Date.now();
        if(task.kind!=='preview')onProgress(Math.round(bytes / total * (task.kind === 'extract' ? 45 : 10)));
        if (percent - loggedPercent < 10 && now - loggedAt < 5000 && percent < 100) return;
        const seconds = (now - downloadStartedAt) / 1000;
        const rate = seconds >= 1 ? bytes / seconds : 0;
        const measured = rate > 0 ? ` · ${(rate / 1048576).toFixed(1)} MiB/s · ~${Math.ceil((total - bytes) / rate)}s remaining` : '';
        logPhase('Downloading source', `${percent}%`, downloadStartedAt, `${(bytes / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MiB${measured}`);
        loggedPercent = percent; loggedAt = now;
      },
    }));});
    if (reusedSource) logPhase('Source cache', 'reused', downloadStartedAt);
    if(task.kind!=='preview')onProgress(task.kind === 'extract' ? 45 : 10);
    if (task.kind === 'extract') {
      const audioPath = join(directory, 'audio.m4a');
      onActivity?.('preparing-analysis');
      const hasAudio = await runPhase('Extracting audio', () => extractSourceAudio(source, audioPath, signal));
      if (!hasAudio) return {};
      onProgress(60);
      let completedOutputs = 0;
      const outputReady = () => { onProgress(60 + ++completedOutputs * 19); };
      // Both operations only read the completed audio file. Wait for both on
      // failure as well so task cleanup cannot remove a file still uploading.
      const [waveformResult, uploadResult] = await Promise.allSettled([
        runPhase('Preparing waveform', () => measureAudioWaveform(audioPath, signal)).then(result => { outputReady(); return result; }),
        runPhase('Saving audio', () => task.outputAssetId ? Promise.resolve(task.outputAssetId) : uploadMediaFile(audioPath, { ...credentials, projectId: task.projectId, kind: 'audio', contentType: 'audio/mp4', fileName: `${asset.fileName.replace(/\.[^.]+$/, '').slice(0, 245)}.m4a`, ...(asset.duration ? { duration: asset.duration } : {}) }, uploadContext, signal)).then(result => { outputReady(); return result; }),
      ]);
      if (waveformResult.status === 'rejected') throw waveformResult.reason;
      if (uploadResult.status === 'rejected') throw uploadResult.reason;
      const waveform = waveformResult.value, audioAssetId = uploadResult.value;
      if (!audioAssetId) throw new Error('Could not store the extracted audio.');
      onProgress(98);
      return { audioAssetId, waveform };
    }
    if (task.kind === 'waveform') return { waveform: await measureAudioWaveform(source, signal) };
    if(task.kind==='preview'){
      if(!posterReady)try{await publishPlaybackPoster(source,directory,task,uploadContext,signal);}catch(error){if(signal.aborted)throw error;console.warn('Could not prepare the footage poster',error instanceof Error?error.message:String(error));}
      await runPhase('Preparing playback',()=>prepareTimelinePlayback(source,directory,task,uploadContext,signal,onProgress,onActivity));
      return {};
    }
    if (task.kind === 'derive') {
      if (task.outputAssetId) return {};
      if (!task.derive || asset.kind === 'audio') throw new AnalysisError('The processing request is unavailable.', 400);
      if (task.derive.op === 'pixelTrack') {
        if (!task.derive.tracking || asset.kind !== 'video') throw new AnalysisError('Pixel tracking request is missing.', 400);
        return { pixelTrack: await runPhase('Tracking pixels', () => trackSourcePixels(source, directory, task.derive!.tracking!, signal, { header: header => (exclusive ?? (work => work()))(() => convex.mutation(pixelTrackApi.pixelTracks.begin, { ...credentials, header })), chunk: chunk => (exclusive ?? (work => work()))(() => convex.mutation(pixelTrackApi.pixelTracks.append, { ...credentials, ...chunk })) })) };
      }
      if (task.derive.op === 'stats') return { colorStats: await runPhase('Measuring color', () => measureColor(source, asset.kind as 'video' | 'image', task.derive!.times ?? [task.derive!.start], signal)) };
      const request = { ...task.derive, op: task.derive.op }, label = request.op === 'parallax' ? 'Preparing depth, foreground matte and inpainted background' : request.op === 'freeze' ? 'Capturing freeze frame' : request.op === 'slowmo' ? 'Interpolating slow motion' : 'Upscaling';
      const output = await runPhase(label, () => deriveMedia(source, asset.kind as 'video' | 'image', directory, request, signal, onProgress));
      const base = asset.fileName.replace(/\.[^.]+$/, '').slice(0, 200), suffix = request.op === 'parallax' ? ' (parallax atlas)' : request.op === 'freeze' ? ` (frame ${(request.time ?? 0).toFixed(2)}s)` : request.op === 'slowmo' ? ` (smooth ${request.factor ?? 2}x)` : ' (upscaled)';
      await runPhase('Saving processed media', () => uploadMediaFile(output.path, { ...credentials, projectId: task.projectId, fileName: `${base}${suffix}.${output.contentType.split('/')[1].replace('jpeg', 'jpg')}`, kind: output.kind, contentType: output.contentType, width: output.width, height: output.height, ...(output.duration ? { duration: output.duration } : {}) }, uploadContext, signal));
      onProgress(98);
      return {};
    }
    if (task.kind === 'genesis') {
      // Genesis (MCP only): depth pass, relight or depth effect. The code lives in the Genesis lane.
      if (task.outputAssetId) return {};
      if (!task.genesis || asset.kind !== 'video') throw new AnalysisError('The Genesis job is unavailable.', 400);
      const work = task.genesis, label = work.job === 'depth' ? 'Estimating depth (VDA-Small)' : work.job === 'relight' ? 'Relighting (LightX)' : 'Compositing depth effect';
      const { file, result } = await runPhase(label, () => runGenesisJob(source, directory, work, convexUrl, signal, onProgress));
      const suffix = work.job === 'depth' ? ' (depth)' : work.job === 'relight' ? ' (relit)' : ` (${String((work.params as { effect?: string }).effect ?? 'depth effect')})`;
      await runPhase('Saving Genesis result', () => uploadMediaFile(file.path, { ...credentials, projectId: task.projectId, fileName: `${asset.fileName.replace(/\.[^.]+$/, '').slice(0, 200)}${suffix}.mp4`, kind: 'video', contentType: 'video/mp4', width: file.width, height: file.height, duration: file.duration }, uploadContext, signal));
      onProgress(98);
      return { genesis: result };
    }
    if (task.kind === 'read') {
      if (!['video', 'image'].includes(asset.kind) || !task.read) throw new AnalysisError('Reading frames needs a video or image and a window.', 400);
      const cache = new FrameCache(convex, credentials, signal), work = task.read;
      if (work.renderedUrl) {
        const response = await fetch(work.renderedUrl, {signal, redirect:'error'});
        if (!response.ok) throw new AnalysisError('The rendered comparison frames are unavailable.', 500);
        work.rendered = (await response.json() as NonNullable<MediaTaskResult['snapshot']>).frames;
      }
      if (work.mode === 'compare') {
        const produce = () => runPhase('Comparing with the reference', () => readCompare(source, directory, work, signal, onProgress, asset.kind === 'image', cache));
        return {read:work.comparisonIdentity?await cache.json(referenceResultDescriptor(work),produce):await produce()};
      }
      const produce = () => runPhase('Reading frames', () => readReference(source, directory, work, signal, onProgress, asset.kind === 'image', cache));
      // Sound descriptions and live font catalogs can change; retain only deterministic readings.
      return { read: work.mode === 'sounds' || work.mode === 'font' ? await produce() : await cache.json(referenceResultDescriptor(work), produce) };
    }
    const media = await runPhase('Reading media information',()=>probeMedia(source, signal));
    if (task.kind === 'cutout') {
      if (task.outputAssetId) return {};
      if (!task.cutout || !media.hasVideo) throw new AnalysisError('The background removal request is unavailable.', 400);
      const output = await runPhase('Removing background', () => removeBackground(source, directory, task.cutout!, signal, onProgress));
      await runPhase('Saving cut-out', () => uploadMediaFile(output.path, { ...credentials, projectId: task.projectId, fileName: `${asset.fileName.replace(/\.[^.]+$/, '').slice(0, 200)} (${task.cutout!.mode === 'foreground' ? 'foreground matte' : 'background removed'}).webm`, duration: output.duration, width: output.width, height: output.height, kind: 'video', contentType: 'video/webm' }, uploadContext, signal));
      onProgress(98);
      return output.subjectMask ? { subjectMask: output.subjectMask } : {};
    }
    if (task.kind === 'frames') {
      if (!media.hasVideo || !task.frameRequest) throw new AnalysisError('Frame inspection needs a video window and a question.', 400);
      const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!key) throw new AnalysisError('Gemini frame inspection is not configured on the media worker.', 503);
      onActivity?.('preparing-analysis');
      const { sourceFps, images,geometry } = await extractInspectionFrames(source, directory, task.frameRequest, media.duration, signal);
      onProgress(60);
      onActivity?.('analyzing');
      return { frameInspection: await runPhase('Inspecting frames',()=>inspectVideoFrames(images, sourceFps, task.frameRequest!, key, signal,geometry)) };
    }
    if(task.kind==='facecam'||task.kind==='speakers'){
      if(!media.hasVideo)throw new AnalysisError('Clipping analysis needs a video source.',400);
      if(task.kind==='facecam')return {analysis:{facecam:asset.analysis?.facecam??await detectSourceFacecam(source,directory,media.duration,signal,onProgress)}};
      const range=task.speakerRequest??{start:0,end:asset.duration??media.duration},cached=asset.analysis?.speakers;
      if(range.start<0||range.end<=range.start||range.end-range.start>MAX_SPEAKER_WINDOW_SECONDS||range.end>(asset.duration??media.duration)+.01)throw new AnalysisError('Active-speaker analysis needs a valid source window of up to 120 seconds.',400);
      if(cached?.version===SPEAKER_ANALYSIS_VERSION&&cached.start<=range.start&&cached.end>=range.end)return {analysis:{speakers:cached}};
      const window=join(directory,'active-speakers.mp4');
      await extractVideoWindow(source,window,range.start,Math.min(range.end,media.duration),signal);
      const duration=range.end-range.start,saved=asset.analysis?.transcript;
      const words=saved?.words.filter(w=>w.end>range.start&&w.start<range.end).map(w=>({...w,start:Math.max(0,w.start-range.start),end:Math.min(duration,w.end-range.start)}));
      let transcript:Transcript|undefined=words&&!words.some(w=>w.speaker===undefined)?{words,segments:[]}:undefined;
      const identityScope=transcript?'source' as const:'window' as const;
      if(!transcript){
        if(!media.hasAudio)throw new AnalysisError('Speaker tracking requires audio.',400);
        const speechKey=process.env.DEEPGRAM_API_KEY;
        if(!speechKey)throw new AnalysisError('Deepgram diarization is not configured on the media worker.',503);
        const audio=join(directory,'speaker-speech.mp3');await extractTranscriptionAudio(window,audio,signal);
        transcript=await transcribeWithDeepgram(audio,duration,speechKey,signal);
      }
      const local=await trackSourceSpeakers(window,directory,duration,transcript,signal,onProgress);
      const speakers=speakerAnalysis.parse({...local,start:range.start,end:range.end,identityScope,turns:local.turns.map(t=>({...t,start:t.start+range.start,end:t.end+range.start})),focus:local.focus.map(p=>({...p,time:p.time+range.start})),...(local.version===2?{framing:local.framing.map(frame=>({...frame,start:frame.start+range.start,end:frame.end+range.start}))}:{})});
      return {analysis:{speakers}};
    }
    if (task.kind === 'highlights') {
      if (!media.hasVideo) throw new AnalysisError('Highlight discovery requires source video for Gemini to watch.', 400, false);
      return {analysis:{highlights:JSON.stringify(await runPhase('Finding highlights',()=>findSourceHighlights({source,duration:asset.duration??media.duration,video:media.hasVideo,transcript:asset.analysis?.transcript,sourceType:task.highlightSourceType,geminiUnavailableReason:task.highlightSkipGemini,sceneCuts:asset.analysis?.shots?.shots.map(s=>s.start),cacheIdentity,cache:new FrameCache(convex,credentials,signal)},signal,onProgress,reportGeminiActivity)))}};
    }
    if (task.kind === 'transcribe') {
      if (!media.hasAudio) throw new AnalysisError('This source has no audio to transcribe.', 400);
      // Older whole-file transcripts lost retakes; only a current one is reused.
      const savedTranscript = currentTranscript(asset.analysis?.transcript) ? asset.analysis?.transcript : undefined;
      // The cleanup map is measured from the same source audio as the quiet intervals. Await it:
      // the task directory holding that audio is removed once this function returns.
      const measure = async (transcript: Transcript) => {
        onActivity?.('analyzing'); onProgress(75);
        const audioActivity = await runPhase('Measuring quiet audio', () => measureAudioActivity(source, signal, transcript));
        const speechCleanup = (asset.duration ?? media.duration) <= 600 ? await runPhase('Finding fillers, pauses and retakes', () => measureSpeechCleanup(source, asset.duration ?? media.duration, transcript, signal)) : undefined;
        return { analysis: { transcript, audioActivity, ...(speechCleanup ? { speechCleanup } : {}) } };
      };
      if (savedTranscript) return await measure(savedTranscript);
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) throw new AnalysisError('Deepgram transcription is not configured on the media worker.', 503);
      const audio = join(directory, 'speech.mp3');
      onActivity?.('preparing-analysis'); onProgress(20);
      await runPhase('Preparing transcription audio',()=>extractTranscriptionAudio(source, audio, signal));
      onProgress(35); onActivity?.('analyzing');
      const transcript = await runPhase('Transcribing speech',()=>transcribeWithDeepgram(audio, asset.duration ?? media.duration, key, signal, attempt => onActivity?.(attempt > 1 ? 'retrying-analysis' : 'analyzing')));
      return await measure(transcript);
    }
    if (task.kind === 'beats') {
      if (!media.hasAudio) throw new AnalysisError('This source has no audio to measure.', 400);
      return { analysis: { beats: await runPhase('Detecting music beats',()=>detectMusicBeats(source, media.duration, signal)) } };
    }
    if (task.kind === 'track') return { analysis: { focus: await runPhase('Tracking subject',()=>trackSourceFace(source, media.duration, onProgress, signal)) } };
    if (task.kind === 'shots') return { analysis: { shots: await runPhase('Detecting shots',()=>detectShots(source, media.duration, signal)) } };
    if (!media.hasVideo) throw new AnalysisError('Footage understanding needs a video source.', 400);
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) throw new AnalysisError('Gemini agentic footage understanding is not configured on the media worker.', 503);
    const contentType = download.contentType?.split(';')[0].trim().toLowerCase() ?? '';
    const mimeType = contentType === 'video/quicktime' ? 'video/mov' : contentType === 'video/x-msvideo' ? 'video/avi' : contentType;
    const nativeType = ['video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'].includes(mimeType);
    const purpose = task.kind === 'video' || task.kind === 'reference' ? 'inspection' : 'overview';
    let video = source, videoMimeType = mimeType;
    const request = task.kind === 'video' ? task.videoRequest : undefined;
    if (task.kind === 'video' && !request) throw new AnalysisError('Native video inspection needs a question and source window.', 400);
    // A question about part of the footage uploads only that part; encoding the
    // window is also the analysis proxy, so the full-length proxy is skipped.
    const windowed = !!request && request.end - request.start < media.duration - 1;
    if (!windowed && (!nativeType || needsAnalysisVideoProxy({ size: download.size, width: download.width, height: download.height }, media.duration, purpose))) {
      const prepared = join(directory, 'analysis.mp4'), preparationStartedAt = Date.now();
      onActivity?.('preparing-analysis');
      // Increment this variant if the corresponding prepareVideo profile changes.
      const reusedAnalysis = await reuseMediaFile({ identity: cacheIdentity, variant: `analysis-${purpose}${preview ? '-preview' : ''}-v1`, target: prepared, signal, ...(nativeType ? { maxBytes: download.size - 1 } : {}) }, () => runPhase('Preparing analysis video',()=>prepareVideo(source, prepared, signal, purpose)));
      if (reusedAnalysis) logPhase('Analysis video cache', 'reused', preparationStartedAt, purpose);
      const preparedBytes = (await stat(prepared)).size;
      // An unusually simple source can already be smaller than the new encode.
      // Keep its native upload in that case; unsupported containers still need MP4.
      if (!nativeType || preparedBytes < download.size) { video = prepared; videoMimeType = 'video/mp4'; }
      logPhase('Analysis video', video === prepared ? 'prepared' : 'using smaller original', preparationStartedAt, `${purpose} · ${(download.size / 1048576).toFixed(1)} MiB ${preview ? 'preview' : 'source'} · ${(preparedBytes / 1048576).toFixed(1)} MiB copy`);
    }
    onProgress(30);
    if (task.kind === 'reference') {
      if (media.duration > MAX_REFERENCE_SECONDS + .5) throw new AnalysisError(`Reference breakdowns cover up to ${MAX_REFERENCE_SECONDS / 60} minutes. Trim the reference to the part that matters.`, 400);
      // Moments: motion inside shots as well as cuts, so a film with few cuts still shows everything that happens.
      const moments = () => runPhase('Finding moments', () => videoMoments(source, signal)).catch(error => { if (signal.aborted) throw error; return []; });
      const saved = readBreakdown(asset.analysis?.reference);
      if (saved) return { analysis: { reference: JSON.stringify({ ...saved, moments: await moments() }) } };
      // Cuts and beats are measured first; the model only labels the measured shots.
      const shots = asset.analysis?.shots ?? await runPhase('Detecting shots', () => detectShots(source, media.duration, signal));
      if (shots.shots.length > MAX_REFERENCE_SHOTS) throw new AnalysisError(`This reference has more than ${MAX_REFERENCE_SHOTS} shots. Trim it to the part that matters.`, 400);
      onProgress(45);
      // Speech or silence has no beat to measure; the breakdown still stands without one.
      const beats = asset.analysis?.beats ?? (media.hasAudio ? await runPhase('Detecting music beats', () => detectMusicBeats(source, media.duration, signal)).catch(error => { if (signal.aborted) throw error; return undefined; }) : undefined);
      onProgress(60);
      onActivity?.('preparing-analysis');
      const keyframes = await runPhase('Sampling shot keyframes', () => extractReferenceKeyframes(source, directory, referenceKeyframes(shots), signal));
      onProgress(70);
      const [reference, found] = await Promise.all([runPhase('Breaking down reference', () => breakDownReference(video, media.duration, shots, keyframes, beats, key, signal, videoMimeType, reportGeminiActivity)), moments()]);
      return { analysis: { shots, ...(beats ? { beats } : {}), reference: JSON.stringify({ ...reference, moments: found }) } };
    }
    if (request) {
      // A preview can end milliseconds before the original; requests use source time.
      if (!windowed) return { videoInspection: await runPhase('Inspecting video',()=>inspectVideo(video, Math.max(media.duration, preview ? asset.duration ?? 0 : 0), request, key, signal, videoMimeType,reportGeminiActivity)) };
      const clip = join(directory, 'window.mp4');
      onActivity?.('preparing-analysis');
      await runPhase('Preparing video window',()=>extractVideoWindow(source, clip, request.start, request.end, signal));
      const clipDuration = Math.min(request.end - request.start, (await probeMedia(clip, signal)).duration);
      const local = await runPhase('Inspecting video',()=>inspectVideo(clip, clipDuration, { question: request.question, start: 0, end: clipDuration }, key, signal, 'video/mp4', reportGeminiActivity));
      // Answers use window time; report them in source time inside the request.
      const toSource = (time: number) => Math.min(request.end, Math.max(request.start, request.start + time));
      return { videoInspection: { ...local, question: request.question, start: request.start, end: request.end, matches: local.matches.map(match => ({ ...match, start: toSource(match.start), end: toSource(match.end) })).filter(match => match.end > match.start) } };
    }
    return { analysis: { understanding: await runPhase('Understanding footage',()=>understandVideo(video, media.duration, key, signal, videoMimeType,reportGeminiActivity,{projectId:task.projectId,taskId:task.taskId})) } };
  } catch(error) {
    if (speechDeadline?.aborted && !parentSignal.aborted) throw new AnalysisError(`Speech preparation and transcription exceeded ${Math.ceil(speechBudget / 1000)} seconds. No transcript was saved. Check the prepared audio or provider connection before explicitly retrying.`, 504, false);
    if(checkpoint&&!isRetryableAnalysisError(error))completed=true;throw error;
  }
  finally { checkpoint?.close(); clearInterval(geminiHeartbeat); if (!checkpoint || completed) await rm(directory, { recursive: true, force: true }); }
}
