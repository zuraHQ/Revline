import { hasPaidModelAccess, requireRunPlan } from './lib/billing_access';
import { freeEditorModel } from '../lib/ai/claude-model';
import { patchTurn, syncTurnView } from './lib/assistant_turn_data';
import { ConvexError, v, type ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { assistantRunArgs, MAX_REPAIR_PASSES } from "./lib/assistant_run";
import { projectRun, writeProject } from "./lib/project_data";
import { loadSceneCode } from "./lib/scene_code";
import { equalTimelineValue } from "../lib/editor/timeline-equality";
import { activeTabOf } from "./timelineTabs";
import { agentRunnerConfigured, startRunnerTurn } from "./lib/runner_turns";
import { aiWorkflow } from "./lib/workflows";
import type { Timeline } from "../lib/editor/types";
import type { Doc } from "./_generated/dataModel";
import { abortStream, listStreams } from "@convex-dev/agent";
import { components } from "./_generated/api";

const scope = {
  projectId: v.id("projects"),
  ownerId: v.string(),
  runId: v.string(),
};
export const turnForRun = (
  ctx: Parameters<typeof projectRun>[0],
  runId: string,
): Promise<Doc<"assistantTurns"> | null> =>
  ctx.db
    .query("assistantTurns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();

export async function rememberTurn(
  ctx: MutationCtx,
  args: ObjectType<typeof assistantRunArgs>,
  project: Doc<"projects">,
): Promise<void> {
  const id=await ctx.db.insert("assistantTurns", {
    projectId: args.projectId,
    runId: args.runId,
    promptMessageId: args.promptMessageId,
    threadId: args.threadId,
    args,
    timelineId: activeTabOf(project),
    pass: 0,
    segment: 0,
    savedEdits: 0,
    pendingFastFrames: [],
    status: "running",
    updatedAt: Date.now(),
  });
  await syncTurnView(ctx,(await ctx.db.get(id))!);
}

export async function dispatchTurn(
  ctx: MutationCtx,
  args: ObjectType<typeof assistantRunArgs>,
): Promise<void> {
  await requireRunPlan(ctx, args.ownerId, args.runId);
  if (!await hasPaidModelAccess(ctx, args.ownerId)) {
    args = { ...args, pinnedModel: freeEditorModel() };
  }
  if (agentRunnerConfigured()) {
    await startRunnerTurn(ctx, args);
    return;
  }
  const workflowId = await aiWorkflow.start(
    ctx,
    internal.assistantWorkflow.runTurn,
    args,
    {
      startAsync: true,
      onComplete: internal.assistantWorkflow.settle,
      context: {
        projectId: args.projectId,
        ownerId: args.ownerId,
        runId: args.runId,
      },
    },
  );
  await writeProject(ctx, args.projectId, { aiWorkflowId: workflowId });
}

/** A server restart enters the next pass of the same bounded repair loop. */
export async function resumeInterruptedTurn(
  ctx: MutationCtx,
  runId: string,
  feedback: string,
): Promise<boolean> {
  const turn = await turnForRun(ctx, runId);
  if (!turn || turn.status !== "running" || turn.pass >= MAX_REPAIR_PASSES)
    return false;
  const run = await projectRun(ctx, turn.projectId, turn.args.ownerId).catch(
    () => null,
  );
  if (!run?.aiRunning || run.aiRunId !== runId) return false;
  const pass = turn.pass + 1,
    segment = turn.segment + 1;
  const continuation = {
    segment,
    repairPass: pass,
    savedEdits: turn.savedEdits,
    pendingFastFrames: turn.pendingFastFrames,
    feedback,
  };
  const streams = await listStreams(ctx, components.agent, {
    threadId: turn.threadId,
    includeStatuses: ["streaming"],
  });
  for (const stream of streams)
    await abortStream(ctx, components.agent, {
      streamId: stream.streamId,
      reason: "Resuming the same request.",
    });
  await patchTurn(ctx,turn, {
    pass,
    segment,
    feedback,
    updatedAt: Date.now(),
  });
  await dispatchTurn(ctx, { ...turn.args, continuation });
  console.info(
    `[ai-repair] ${JSON.stringify({ event: "scheduled-continuation", projectId: turn.projectId, runId, pass, segment })}`,
  );
  return true;
}

export const advance = internalMutation({
  args: {
    ...scope,
    expectedPass: v.number(),
    segment: v.number(),
    feedback: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const turn = await turnForRun(ctx, args.runId),
      run = await projectRun(ctx, args.projectId, args.ownerId);
    if (!run.aiRunning || run.aiRunId !== args.runId) return false;
    // Native administrative turns started before rollout still have the same local bound.
    if (!turn) return args.expectedPass < MAX_REPAIR_PASSES;
    if (
      turn.status !== "running" ||
      turn.pass !== args.expectedPass ||
      turn.segment !== args.segment ||
      turn.pass >= MAX_REPAIR_PASSES
    )
      return false;
    await patchTurn(ctx,turn, {
      pass: turn.pass + 1,
      feedback: args.feedback.slice(0, 14000),
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const interrupted = internalMutation({
  args: { ...scope, feedback: v.string(), segment:v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await projectRun(ctx, args.projectId, args.ownerId);
    const turn=await turnForRun(ctx,args.runId);
    if(turn&&turn.segment!==args.segment)return false;
    return resumeInterruptedTurn(
      ctx,
      args.runId,
      args.feedback.slice(0, 14000),
    );
  },
});

export const checkpoint = internalMutation({
  args: {
    ...scope,
    segment: v.number(),
    savedEdits: v.number(),
    pendingFastFrames: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await turnForRun(ctx, args.runId);
    if (
      turn &&
      turn.projectId === args.projectId &&
      turn.args.ownerId === args.ownerId &&
      turn.status === "running" &&
      turn.segment === args.segment
    )
      await patchTurn(ctx,turn, {
        savedEdits: Math.max(turn.savedEdits, args.savedEdits),
        pendingFastFrames: args.pendingFastFrames,
        updatedAt: Date.now(),
      });
    return null;
  },
});

/** Only the same run and base revision may restore a private checkpoint. */
export const draft = internalQuery({
  args: scope,
  handler: async (
    ctx,
    args,
  ): Promise<{ timeline: Timeline; revision: number } | null> => {
    const run = await projectRun(ctx, args.projectId, args.ownerId);
    if (!run.aiRunning || run.aiRunId !== args.runId)
      throw new ConvexError("AI run is no longer active");
    const project = await ctx.db.get(args.projectId),
      preview = await ctx.db
        .query("aiTimelinePreviews")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .unique();
    if (
      !preview ||
      preview.runId !== args.runId ||
      preview.ownerId !== args.ownerId ||
      preview.baseRevision !== (project?.revision ?? 0)
    )
      return null;
    if (
      project?.timeline &&
      equalTimelineValue(project.timeline, preview.timeline)
    )
      return null;
    const published = await ctx.db
      .query("toolWriteReceipts")
      .withIndex("by_run_stage", (q) =>
        q.eq("runId", args.runId).eq("stagedRevision", preview.baseRevision),
      )
      .first();
    if (published?.receipt?.status === "saved") return null;
    return {
      timeline: await loadSceneCode(ctx, preview.timeline),
      revision: preview.baseRevision,
    };
  },
});
