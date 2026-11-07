import { checkCompletion } from '../../lib/ai/lanes/clip/check';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { LANES, type LaneId } from '../../lib/ai/lanes';
import {
  changedFrameTimes,
  LaneFinishError,
  MAX_FINISH_ATTEMPTS,
} from '../../lib/ai/lanes/task';
import { timelineHistoryKey } from '../../lib/editor/timeline-history-key';
import type { Timeline } from '../../lib/editor/types';
import { FastFrameReview, fastFrameEvidence, isPlainReelTimeline } from '../../lib/ai/fast-frame-review';
import { reelCaptionFailures, reelFinishKey } from '../../lib/ai/lanes/reel/check';
import { summarizeTimeline } from './inspectTimeline';
import type { EditorRun, LaneTask } from './run_types';
import type { GenesisJobEvidence, GenesisLayerEvidence, LaneEvidence, ReferenceMotionEvidence } from '../../lib/ai/lanes/types';
import { referenceMotionTargets } from '../../lib/ai/lanes/recreate/motion';
import { motionReport, motionTimelineKey } from '../../lib/ai/motion-coverage';
export type FinishResult = NonNullable<LaneTask['result']>;
/** The turn ends here: the lane used up its finish attempts. */
export function exhaustedLaneError(lane: string, failures: string) {
  return new LaneFinishError(`The ${lane} task stopped after three failed finish checks: ${failures}`);
}
type Render = (
  times: number[],
  revision?: number,
  timelineId?: string,
) => Promise<{ revision: number; frames: { time: number; image: string }[] }>;

/** Executes real checks; finish takes no model-provided scores, counts or acceptance flags. */
export async function finishLane(
  ctx: ActionCtx,
  options: {
    run: EditorRun;
    taskId: string;
    timelineId: string;
    timeline: Timeline;
    assets: Doc<'assets'>[];
    render: Render;
    staged: boolean;
    /** The reel lane's pending sampled frames, passed only for its standard (sample) recipe. */
    fastFrameTimes?: number[];
    clipping?: () => Promise<{
      required: boolean;
      passed: boolean;
      errors: string[];
      finalMessage?: string;
    }>;
  },
): Promise<FinishResult> {
  const { run, taskId, timelineId, timeline, assets } = options,
    scope = { ownerId: run.ownerId, projectId: run.projectId, taskId };
  const task = (await ctx.runQuery(
    internal.lanes.task,
    scope,
  )) as LaneTask | null;
  if (!task) throw new Error('Start a lane task before finishing.');
  if (task.attempts >= MAX_FINISH_ATTEMPTS && task.result) return task.result;
  const fingerprint = await timelineHistoryKey(timeline),
    failures: string[] = [],
    warnings: string[] = [];
  if (task.lane === 'reel') failures.push(...reelCaptionFailures(timeline, assets));
  const motionReports: string[] = [], motionOff: NonNullable<FinishResult['motionOff']> = [];
  let currentRevision: number | undefined;
  const tabs = (await ctx.runQuery(internal.lanes.timelines, scope)) as {
    timelineId: string;
    timeline: Timeline | null;
  }[];
  const checked = tabs.map((tab) =>
    tab.timelineId === timelineId ? { ...tab, timeline } : tab,
  );
  if (!checked.some((tab) => tab.timelineId === timelineId))
    checked.push({ timelineId, timeline });
  const sparseReel = task.lane === 'reel' && options.fastFrameTimes !== undefined && isPlainReelTimeline(timeline);
  const revision = sparseReel ? (await ctx.runQuery(internal.assistant.getRunTimeline, run)).revision : undefined;
  const checkedTimelines = sparseReel ? await Promise.all(checked.map(async tab => ({ timelineId: tab.timelineId, fingerprint: tab.timeline ? await timelineHistoryKey(tab.timeline) : null }))) : [];
  const checkKey = (evidence: LaneEvidence[]) => revision === undefined ? undefined : reelFinishKey({ fingerprint, revision, evidence, timelines: checkedTimelines, assets });
  const initialKey = await checkKey(task.evidence);
  if (initialKey && task.result?.checkKey === initialKey && !task.result.passed)
    return ctx.runMutation(internal.lanes.recordFinish, { ...scope, result: task.result });
  // Genesis layers are checked wherever the timeline uses them, whatever the lane: as clips or scene media.
  const usedAssetIds = [...new Set(checked.flatMap(tab => tab.timeline?.clips.flatMap(clip => [...clip.assetId ? [clip.assetId] : [], ...clip.scene?.media?.map(item => item.assetId) ?? []]) ?? []))];
  let genesisLayers: GenesisLayerEvidence[] | undefined, genesisJobs: GenesisJobEvidence[] | undefined;
  for (const tab of task.lane === 'clip' ? [] : checked) {
    const baseline = task.baselines.find(
      (item) => item.timelineId === tab.timelineId,
    );
    if (!tab.timeline) {
      failures.push(`Timeline ${tab.timelineId} was removed before its check.`);
      continue;
    }
    const key = await timelineHistoryKey(tab.timeline);
    if (tab.timelineId !== timelineId && baseline?.fingerprint === key)
      continue;
    const summary = summarizeTimeline(tab.timeline, assets),
      prefix =
        tab.timelineId === timelineId ? '' : `Timeline ${tab.timelineId}: `;
    const referencePolicy = LANES[task.lane].referenceMotion;
    const targets = referencePolicy ? referenceMotionTargets(tab.timeline, assets, tab.timelineId, referencePolicy === 'required') : [];
    const referenceMotion: ReferenceMotionEvidence[] = [];
    for (const target of targets) {
      currentRevision ??= (await ctx.runQuery(internal.assistant.getRunTimeline, run)).revision;
      const state = await ctx.runQuery(internal.referenceMotion.state, { ownerId: run.ownerId, projectId: run.projectId, assetId: target.assetId as Id<'assets'>, timelineId: tab.timelineId });
      const evidence = { ...target, ...state, projectId: run.projectId, revision: currentRevision!, timelineKey: await motionTimelineKey(tab.timeline) };
      referenceMotion.push(evidence);
      motionReports.push(prefix + motionReport(evidence));
      motionOff.push(...state.off.map(item => ({ ...item, assetId: target.assetId, timelineId: tab.timelineId })));
    }
    const checksReference = referencePolicy === 'required' || targets.length > 0;
    if (
      !summary.clipCount ||
      summary.duration <= 0 ||
      !tab.timeline.clips.some((clip) =>
        ['video', 'image', 'solid', 'scene'].includes(clip.kind),
      )
    )
      failures.push(`${prefix}The task has no nonempty visual edit to finish.`);
    if (summary.missingAssetRefs.length)
      failures.push(
        `${prefix}Missing source media: ${summary.missingAssetRefs.map((item) => item.clipId).join(', ')}.`,
      );
    if (summary.overlapCount)
      failures.push(
        `${prefix}Resolve ${summary.overlapCount} same-layer collisions.`,
      );
    const newGaps = summary.gaps.filter(
      (gap) =>
        !baseline?.gaps.some(
          (old) =>
            gap.start >= old.start - 1 / tab.timeline!.fps &&
            gap.end <= old.end + 1 / tab.timeline!.fps,
        ),
    );
    if (newGaps.length)
      failures.push(
        `${prefix}New uncovered visual ranges: ${newGaps.map((gap) => `${gap.start.toFixed(2)}–${gap.end.toFixed(2)}s`).join(', ')}.`,
      );
    try {
      await ctx.runMutation(internal.lanes.validate, {
        ownerId: run.ownerId,
        projectId: run.projectId,
        timeline: tab.timeline,
      });
    } catch (error) {
      failures.push(
        `${prefix}${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Reference lanes already require dense rendered pairs, or explicit OFF windows, below.
    if (!failures.length && summary.clipCount && summary.duration > 0 && !checksReference) {
      const fastTimes = task.lane === 'reel' && tab.timelineId === timelineId && isPlainReelTimeline(tab.timeline) ? options.fastFrameTimes : undefined;
      const pendingReview = fastTimes === undefined ? undefined : new FastFrameReview(fastTimes);
      const times = fastTimes ?? (baseline
        ? await changedFrameTimes(tab.timeline, baseline)
        : [0, summary.duration / 2]);
      // A plain reel at the standard level reuses its pending queue; other paths retain the rendered finish check.
      if (!times.length && fastTimes === undefined)
        times.push(
          Math.min(
            summary.duration / 2,
            Math.max(0, summary.duration - 1 / tab.timeline.fps),
          ),
        );
      try {
        for (let index = 0; index < times.length; index += 4) {
          const batch = times.slice(index, index + 4),
            rendered = await options.render(batch, undefined, tab.timelineId);
          if (
            rendered.frames.length !== batch.length ||
            rendered.frames.some((frame) => !frame.image)
          )
            throw new Error('Changed-range rendering returned missing frames.');
          if (pendingReview) {
            pendingReview.reviewed(rendered.frames.map(frame => frame.time), tab.timeline);
            await ctx.runMutation(internal.lanes.evidence, { ...scope, evidence: fastFrameEvidence(tab.timelineId, key, pendingReview.times()) });
          }
        }
      } catch (error) {
        failures.push(
          `${prefix}Changed ranges did not render: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (task.lane !== 'clip') {
      const context = {
        timeline: tab.timeline,
        evidence: task.evidence as LaneEvidence[],
        fingerprint: key,
        timelineId: tab.timelineId,
        assets,
        referenceMotion,
        genesis: genesisLayers ??= task.lane === 'genesis' || usedAssetIds.length ? await ctx.runQuery(internal.genesis.forCheck, { ownerId: run.ownerId, projectId: run.projectId, usedAssetIds }) : [],
        // Applied relights and depth effects keep their range and frame checks the same way.
        genesisJobs: genesisJobs ??= task.lane === 'genesis' || usedAssetIds.length ? await ctx.runQuery(internal.genesisJobs.forCheck, { ownerId: run.ownerId, projectId: run.projectId }) : [],
      };
      failures.push(...LANES[task.lane].check(context).map((error) => prefix + error));
      warnings.push(...(LANES[task.lane].warn?.(context) ?? []).map((warning) => prefix + warning));
      // Any lane that uses a Genesis layer (a cut-out clip, scene media, a layer function) keeps its layer checks.
      if (task.lane !== 'genesis' && (genesisLayers.length || genesisJobs.length)) {
        failures.push(...LANES.genesis.check(context).map((error) => prefix + error));
        warnings.push(...(LANES.genesis.warn?.(context) ?? []).map((warning) => prefix + warning));
      }
    }
  }
  if (task.lane === 'clip') {
    // The stable task key spans separate MCP calls; the upstream ledger verifies every actual tab.
    failures.push(
      ...(await checkCompletion(
        options.clipping ??
          (() =>
            ctx.runQuery(
              makeFunctionReference<'query'>('clipping:completionState'),
              { ...run, runId: taskId, timelineId, timeline },
            )),
      )),
    );
  }
  const finalCheckKey = initialKey ? await checkKey(((await ctx.runQuery(internal.lanes.task, scope)) as LaneTask).evidence) : undefined;
  const result: FinishResult = {
    passed: failures.length === 0,
    lane: task.lane as LaneId,
    attempt: task.attempts + 1,
    exhausted: false,
    failures: [...new Set(failures)],
    fingerprint,
    timelineId,
    ...(finalCheckKey ? { checkKey: finalCheckKey } : {}),
    ...(motionReports.length ? { motionCheck: motionReports.join('\n') } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    ...(motionOff.length ? { motionOff } : {}),
  };
  return ctx.runMutation(internal.lanes.recordFinish, { ...scope, result });
}
