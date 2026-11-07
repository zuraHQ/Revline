import { openLayersAbove } from '../../../../editor/cutout-effects';
import { sourceEndOf } from '../../../../editor/playback-rate';
import { deriveTrackCounts, normalizeTimeline, trackOf, type Clip, type Timeline } from '../../../../editor/types';

/** A ready Genesis layer: a transparent cut-out of the SAM 3.1 subject on the source's own clock. */
export type ReadyLayer = { layerId: string; clipId: string; sourceAssetId: string; outputAssetId: string; start: number; end: number; fps: number };
export type Applied = { timeline: Timeline; baseClipId: string; clipIds: string[]; subjectClipIds: string[] };

/** The footage clip a layer function edits: same source as the layer, inside the masked range. */
export function baseClip(timeline: Timeline, layer: ReadyLayer, clipId = layer.clipId): Clip {
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} is not on this timeline. Pass clipId of the footage clip that shows the layer's subject.`);
  if (clip.kind !== 'video' || clip.assetId !== layer.sourceAssetId) throw new Error(`Layer ${layer.layerId} was segmented from other footage, or the clip shows a relight or depth effect (layer functions would stack the original subject over it). Use the original footage clip, or depthEffect with keepLayerId.`);
  const frame = 1 / layer.fps;
  if (clip.sourceStart < layer.start - frame || sourceEndOf(clip) > layer.end + frame)
    throw new Error(`Layer ${layer.layerId} masks source ${layer.start.toFixed(2)}–${layer.end.toFixed(2)}s but clip ${clip.id} plays ${clip.sourceStart.toFixed(2)}–${sourceEndOf(clip).toFixed(2)}s. Split the clip at the layer's range, or segment the whole clip.`);
  return clip;
}

/** A silent, unlinked copy of the base clip in exact sync: same timing, framing, speed and motion. */
export function syncedCopy(clip: Clip, id: string, track: number, extra: Partial<Clip> = {}): Clip {
  const { linkedClipId: _linked, transition: _transition, audio: _audio, audioFadeTiming: _fade, outline: _outline, ...visual } = clip;
  return { ...visual, id, track, volume: 0, audioSeparated: true, ...extra };
}

/** Genesis clips already stacked on a footage clip by earlier functions (from the layer records). */
export type ExistingStack = { clipIds: readonly string[]; subjectClipIds: readonly string[] };
export type StackParts = { plate?: Clip; text?: Clip; subject?: Clip };

/** Inserts new Genesis clips into the footage clip's stack by role, whatever was applied first:
 * footage < plates (colour/blur backgrounds) < titles < subject cut-outs. Each new clip gets its own
 * new row just above the highest clip of its role or below; nothing already placed is repacked, so
 * unrelated clips on the rows above keep their order and never share a row with a Genesis clip.
 * A plain subject copy of the same mask (same look as the footage) is reused instead of stacked again. */
export function placeStack(input: Timeline, clip: Clip, existing: ExistingStack, parts: StackParts): { timeline: Timeline; subject?: Clip } {
  let timeline = normalizeTimeline(input);
  const ids = new Set(existing.clipIds), subjects = new Set(existing.subjectClipIds), roles = new Map<string, number>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const plain = (item: Clip) => !item.outline && same(item.colorGrade, clip.colorGrade) && same(item.softBlur, clip.softBlur);
  for (const item of timeline.clips) if (ids.has(item.id) && trackOf(item) > trackOf(clip)) roles.set(item.id, subjects.has(item.id) ? 2 : item.kind === 'video' ? 0 : 1);
  const reused = parts.subject && plain(parts.subject) ? timeline.clips.find(item => roles.get(item.id) === 2 && item.assetId === parts.subject!.assetId && plain(item)) : undefined;
  const added: [Clip, number][] = [[parts.plate, 0], [parts.text, 1], [reused ? undefined : parts.subject, 2]].filter((entry): entry is [Clip, number] => !!entry[0]);
  for (const [item, role] of added) {
    const below = Math.max(trackOf(clip), ...timeline.clips.filter(other => (roles.get(other.id) ?? 3) <= role).map(trackOf));
    const opened = openLayersAbove(timeline, below, 1);
    const next = { ...opened, clips: [...opened.clips, { ...item, track: below + 1 }] };
    timeline = { ...next, tracks: deriveTrackCounts(next) };
    roles.set(item.id, role);
  }
  return { timeline, subject: reused ?? parts.subject };
}

export const hexColor = /^#[\da-f]{6}$/i;
