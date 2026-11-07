import { playbackRateOf, sourceEndOf, sourceTimeAt } from '../../../editor/playback-rate';
import type { Clip } from '../../../editor/types';
import { currentEvidence, type GenesisLayerEvidence, type LaneCheckContext } from '../types';

const range = (start: number, end: number) => `${start.toFixed(2)}–${end.toFixed(2)}s`;
const sameRamp = (a: Clip, b: Clip) => JSON.stringify(a.speedRamp ?? null) === JSON.stringify(b.speedRamp ?? null);

/** Shared scene timing: every <video> in the code carries the same literal data-start, data-offset and data-rate
 * (the scene runtime's clock: source = offset + (sceneTime - start) * rate). Null when any is computed, differs or loops. */
export function sceneVideoTiming(code: string) {
  // Quoted values may contain '>'; a tag cut short inside a ${...} expression is unreadable.
  const tags = code.match(/<video\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? [];
  if (!tags.length || tags.some(tag => (tag.match(/\$\{/g) ?? []).length > (tag.match(/\}/g) ?? []).length)) return null;
  const read = (tag: string, name: string, fallback: number) => {
    const match = tag.match(new RegExp(`\\bdata-${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    if (!match) return fallback;
    const value = (match[1] ?? match[2] ?? match[3]).trim();
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  };
  const timings = tags.map(tag => ({ start: read(tag, 'start', 0), offset: read(tag, 'offset', 0), rate: read(tag, 'rate', 1), loop: /\bdata-loop\b/i.test(tag) }));
  const [first] = timings;
  if (timings.some(item => item.loop || !Number.isFinite(item.start) || !Number.isFinite(item.offset) || !(item.rate > 0) || item.start !== first.start || item.offset !== first.offset || item.rate !== first.rate)) return null;
  return first;
}

type Use = { label: string; layer: GenesisLayerEvidence; frame: number };

/** The mask must cover a played source range and show the subject somewhere in it. */
function coverage(use: Use, from: number, to: number, what: string, fix: string): string | null {
  const { layer, frame, label } = use;
  if (from < layer.start - frame || to > layer.end + frame) return `${label}: ${what} plays source ${range(from, to)} but the mask covers only ${range(layer.start, layer.end)}. ${fix}`;
  const boxes = layer.boxes ?? [], first = Math.max(0, Math.floor((from - layer.start) * layer.fps)), last = Math.min(boxes.length, Math.ceil((to - layer.start) * layer.fps));
  if (boxes.length && !boxes.slice(first, last).some(box => box)) return `${label}: the mask is empty over source ${range(from, to)}; SAM 3.1 lost the subject. Segment again with a box on a clear frame.`;
  return null;
}

/** Footage of the layer's source that overlaps [start, end) on the timeline. */
const footageUnder = (clips: Clip[], layer: GenesisLayerEvidence, start: number, end: number) =>
  clips.filter(clip => clip.kind === 'video' && clip.assetId === layer.sourceAssetId && clip.start < end - 1e-3 && clip.start + clip.duration > start + 1e-3);

/** Failures and warnings for every Genesis layer this timeline uses: through layer functions, as a clip, or as scene media. */
export function review(context: LaneCheckContext): { failures: string[]; warnings: string[] } {
  const failures: string[] = [], warnings: string[] = [], clips = new Map(context.timeline.clips.map(clip => [clip.id, clip]));
  const spans: { start: number; end: number }[] = [];
  for (const layer of context.genesis ?? []) {
    const frame = 1 / layer.fps, placedByFunctions = new Set<string>();
    for (const use of layer.applications.filter(use => use.timelineId === context.timelineId)) {
      const placed = use.clipIds.map(id => clips.get(id)).filter(clip => !!clip);
      placed.forEach(clip => placedByFunctions.add(clip.id));
      if (!placed.length) continue;
      const base = clips.get(use.baseClipId), label = `${use.function} on layer ${layer.layerId}`;
      if (layer.status !== 'ready' || !layer.outputAssetId) { failures.push(`${label}: the layer is ${layer.status}. Poll getLayer until ready, or segment again.`); continue; }
      if (!base) { failures.push(`${label}: its footage clip ${use.baseClipId} was removed. Delete clips ${placed.map(clip => clip.id).join(', ')} or re-apply on the new footage.`); continue; }
      // Titles keep their own timing; only video copies (plates and subjects) must match the footage.
      for (const copy of placed.filter(clip => clip.kind === 'video')) {
        // Copies must show the same source instant as the footage at every timeline time.
        if (Math.abs(copy.start - base.start) > 1e-3 || Math.abs(copy.duration - base.duration) > 1e-3 || Math.abs(sourceTimeAt(copy, copy.start) - sourceTimeAt(base, copy.start)) > frame / 2 || playbackRateOf(copy) !== playbackRateOf(base) || !sameRamp(copy, base))
          failures.push(`${label}: clip ${copy.id} is out of sync with footage ${base.id}. Move/trim it to match (start ${base.start.toFixed(3)}, duration ${base.duration.toFixed(3)}, sourceStart ${base.sourceStart.toFixed(3)}) or re-apply.`);
      }
      for (const subject of use.subjectClipIds.map(id => clips.get(id)).filter(clip => !!clip)) {
        if (subject.assetId !== layer.outputAssetId) { failures.push(`${label}: clip ${subject.id} no longer uses the layer's mask.`); continue; }
        const failure = coverage({ label, layer, frame }, subject.sourceStart, sourceEndOf(subject), `clip ${subject.id}`, 'Split the footage or segment the range.');
        if (failure) failures.push(failure);
      }
      spans.push({ start: base.start, end: base.start + base.duration });
    }
    if (!layer.outputAssetId) continue;
    const notReady = layer.status !== 'ready' ? `the layer is ${layer.status}. Poll getLayer until ready, or segment again.` : null;
    // The layer's cut-out added directly as a clip (addMedia, a copy, ...), outside any layer function.
    for (const clip of context.timeline.clips.filter(clip => clip.kind === 'video' && clip.assetId === layer.outputAssetId && !placedByFunctions.has(clip.id))) {
      const use = { label: `Layer ${layer.layerId} as clip ${clip.id}`, layer, frame }, end = clip.start + clip.duration;
      if (notReady) failures.push(`${use.label}: ${notReady}`);
      const failure = coverage(use, clip.sourceStart, sourceEndOf(clip), 'it', 'Trim the clip into the mask range, or segment the range it plays.');
      if (failure) failures.push(failure);
      const footage = footageUnder(context.timeline.clips, layer, clip.start, end);
      // Over its own footage the cut-out must show the same source instant, or the subject doubles.
      for (const base of footage) {
        const at = Math.max(clip.start, base.start);
        if (Math.abs(sourceTimeAt(clip, at) - sourceTimeAt(base, at)) > frame / 2 || playbackRateOf(clip) !== playbackRateOf(base) || !sameRamp(clip, base))
          failures.push(`${use.label}: out of sync with footage ${base.id} at ${at.toFixed(2)}s (cut-out source ${sourceTimeAt(clip, at).toFixed(3)}s, footage ${sourceTimeAt(base, at).toFixed(3)}s). Give it the footage's start, sourceStart and speed.`);
      }
      spans.push({ start: clip.start, end });
    }
    // The cut-out as scene media: the scene's <video> timing decides which source frames play.
    for (const scene of context.timeline.clips.filter(clip => clip.kind === 'scene' && clip.scene?.media?.some(item => item.assetId === layer.outputAssetId))) {
      const use = { label: `Layer ${layer.layerId} in scene clip ${scene.id}`, layer, frame }, end = scene.start + scene.duration;
      spans.push({ start: scene.start, end });
      if (notReady) failures.push(`${use.label}: ${notReady}`);
      const timing = scene.speedRamp?.length ? null : sceneVideoTiming(scene.scene?.code ?? '');
      if (!timing) {
        warnings.push(`${use.label}: its <video> timing is computed, looped or differs between videos, so mask coverage and sync with the footage were not machine-checked. Write the same literal data-start, data-offset and data-rate on every <video>, or confirm with getFrames that the subject stays on its footage.`);
        continue;
      }
      // Scene second at a timeline second: films show their window from sourceStart, at the clip's speed.
      const sceneRate = playbackRateOf(scene), sceneTime = (time: number) => scene.sourceStart + (time - scene.start) * sceneRate;
      const source = (time: number) => timing.offset + Math.max(0, sceneTime(time) - timing.start) * timing.rate;
      const failure = coverage(use, source(scene.start), source(end), 'its <video>', 'Segment the range the scene plays, or set data-start/data-offset so the video plays inside the mask.');
      if (failure) failures.push(failure);
      for (const base of footageUnder(context.timeline.clips, layer, scene.start, end)) {
        const at = Math.max(scene.start, base.start, scene.start + Math.max(0, timing.start - scene.sourceStart) / sceneRate);
        if (at >= Math.min(end, base.start + base.duration) - 1e-3) continue;
        if (Math.abs(source(at) - sourceTimeAt(base, at)) > frame / 2 || Math.abs(timing.rate * sceneRate - playbackRateOf(base)) > 1e-6 || base.speedRamp?.length)
          failures.push(`${use.label}: out of sync with footage ${base.id} at ${at.toFixed(2)}s (cut-out source ${source(at).toFixed(3)}s, footage ${sourceTimeAt(base, at).toFixed(3)}s). Match data-start/data-offset/data-rate to the footage clip.`);
      }
    }
  }
  // Relights and depth effects: the clip still plays inside the processed source range.
  for (const job of context.genesisJobs ?? []) {
    for (const use of job.applications.filter(use => use.timelineId === context.timelineId)) {
      const clip = clips.get(use.clipId);
      if (!clip || clip.assetId !== job.outputAssetId) continue;
      const frame = 1 / context.timeline.fps, from = clip.sourceStart, to = sourceEndOf(clip);
      if (from < job.start - frame || to > job.end + frame) { failures.push(`${job.kind} ${job.jobId}: clip ${clip.id} plays source ${range(from, to)} but the result covers only ${range(job.start, job.end)}. Trim the clip back, or undo and run the job on the new range.`); continue; }
      spans.push({ start: clip.start, end: clip.start + clip.duration });
    }
  }
  if (!spans.length) return { failures, warnings };
  // Frames read at the current timeline fingerprint were taken after the last edit, Genesis included.
  const seen = currentEvidence(context, 'getFrames').flatMap(item => Array.isArray(item.input.times) ? item.input.times.filter((time): time is number => typeof time === 'number') : []);
  // One entry per range: several layers in one scene share its span.
  const unique = [...new Map(spans.map(span => [`${span.start.toFixed(3)}:${span.end.toFixed(3)}`, span])).values()];
  const unseen = unique.filter(span => !seen.some(time => time >= span.start - 1e-3 && time < span.end));
  if (unseen.length) failures.push(`No getFrames after the last Genesis edit inside ${unseen.map(span => range(span.start, span.end)).join(', ')}. Call getFrames with times ${JSON.stringify(unseen.map(span => Math.round((span.start + span.end) / 2 * 100) / 100))} and look at the subject edges.`);
  return { failures, warnings };
}

// finish asks for failures and warnings of the same context; review it once.
const reviewed = new WeakMap<LaneCheckContext, ReturnType<typeof review>>();
const once = (context: LaneCheckContext) => reviewed.get(context) ?? reviewed.set(context, review(context)).get(context)!;
/** Every Genesis layer this timeline uses is ready, covers what plays, stays in sync, and was looked at after the last edit. */
export const check = (context: LaneCheckContext) => once(context).failures;
export const warn = (context: LaneCheckContext) => once(context).warnings;
