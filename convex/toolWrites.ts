import { patchTurn } from './lib/assistant_turn_data';
import { makeFunctionReference } from 'convex/server';
import { ConvexError, v, convexToJson, jsonToConvex, type Infer } from 'convex/values';
import {internal} from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { toolBehavior } from '../lib/ai/tool-definitions';
import { savesNothing, toolWriteReceipt } from './lib/tool_write_receipt';
import { projectIdentity } from './lib/project_data';
import { saveEvidence } from './lib/lane_evidence';
import { turnForRun } from './assistantTurnRecovery';
import {timelineHistoryKey} from '../lib/editor/timeline-history-key';
import {FastFrameReview, fastReelFrameMoments, readFastFrameTimes, fastFrameEvidence} from '../lib/ai/fast-frame-review';
import {laneChecks, taskCheckLevel} from '../lib/ai/lanes/checks';

// Only tool-layer mutations are reachable through the runner's transactional bridge.
const mutations = new Set([
  'generatedImages:prepare', 'generatedImages:save', 'generatedImages:cleanup', 'aiCosts:record',
  'assistant:apply', 'assistant:undoLatestEdit', 'assistant:createRunTimeline', 'assistant:openRunTimeline',
  'assistant:beginEditing', 'assistant:previewDraft', 'assistant:requestAnalysis', 'assistant:clearAnalysis',
  'assistant:attachRunStockAudio', 'assistant:reserveAudioRequest', 'assistant:reserveSoundGeneration', 'assistant:saveGeneratedSound', 'assistant:importRunVideo', 'assistant:exportRunVideo',
  'blueprints:requestCheck', 'blueprints:saveFromCheck', 'brandKits:create', 'brandKits:update',
  'compositionReview:savePlan', 'compositionReview:request', 'compositionReview:cancel',
  'cutouts:startFromRun', 'derivations:startFromRun',
  'mcp:requestFrames', 'mcp:requestGuard', 'mcp:discardFrames', 'mcp:takeFrames',
  'briefs:update', 'memories:remember', 'memories:forget',
  'referenceReads:request', 'referenceReads:take', 'referenceReads:discard',
]);
const scope = { projectId: v.id('projects'), ownerId: v.string(), runId: v.string() };

/** The write, revision comparison and receipt commit in one transaction. */
export const run = internalMutation({
  args: { ...scope, toolName: v.string(), writeId: v.string(), functionName: v.string(), input: v.record(v.string(), v.any()), segment:v.optional(v.number()) },
  returns: v.object({ value: v.any(), receipt: v.optional(toolWriteReceipt),replayed:v.optional(v.boolean()) }),
  handler: async (ctx, args) => {
    const definition = toolBehavior(args.toolName);
    if (!definition || savesNothing(definition.effect) || !mutations.has(args.functionName)) throw new ConvexError(`This mutation is not registered for editing tools: ${args.toolName} -> ${args.functionName}.`);
    await projectIdentity(ctx, args.projectId, args.ownerId);
    const existing = await ctx.db.query('toolWriteReceipts').withIndex('by_write', q => q.eq('writeId', args.writeId)).unique();
    if (existing) {
      if(existing.projectId!==args.projectId||existing.ownerId!==args.ownerId||existing.runId!==args.runId||existing.toolName!==args.toolName&&!(args.functionName==='assistant:apply'&&args.input.stagedPublication===true)||existing.functionName!==args.functionName)throw new ConvexError('The write identity belongs to another operation.');
      if(existing.valueParts){
        const parts=await ctx.db.query('toolWriteResultParts').withIndex('by_write_part',q=>q.eq('writeId',args.writeId)).take(existing.valueParts);
        if(parts.length!==existing.valueParts)throw new ConvexError('The saved result is unavailable. Inspect the committed state before continuing.');
        return {value:jsonToConvex(JSON.parse(parts.map(part=>part.value).join(''))),replayed:true,...(existing.receipt?{receipt:existing.receipt}:{})};
      }
      if(existing.value!==undefined)return {value:existing.value,replayed:true,...(existing.receipt?{receipt:existing.receipt}:{})};
      throw new ConvexError('This write already committed. Read its receipt instead of repeating it.');
    }
    const turn=await turnForRun(ctx,args.runId);
    if(turn&&(turn.status!=='running'||turn.segment!==(args.segment??0)))throw new ConvexError('This editing attempt has been replaced.');
    for (const key of ['projectId', 'ownerId', 'runId'] as const) {
      if (args.input[key] !== undefined && args.input[key] !== args[key]) throw new ConvexError('The tool mutation belongs to another run.');
    }
    const beforeProject=await ctx.db.get(args.projectId),before=beforeProject?.revision??0;
    const timelineWrite = args.functionName === 'assistant:previewDraft' || args.functionName === 'assistant:apply';
    const beforePreview = turn && timelineWrite ? await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',args.projectId)).unique() : null;
    let value;
    try {
      value = await ctx.runMutation(makeFunctionReference<'mutation'>(args.functionName), args.input);
      if (value && typeof value === 'object' && (value.success === false || value.isError === true || value.error)) throw new Error(typeof value.error === 'string' ? value.error : 'The mutation rejected this change.');
    }
    catch (error) {
      // A sub-transaction failure rolls back its writes; callers may safely report this as a failed write.
      throw new ConvexError({ kind: 'tool-write-failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
    }
    const afterProject=await ctx.db.get(args.projectId),after=afterProject?.revision??before;
    const declared = definition.writes?.includes(args.functionName);
    let receipt: Infer<typeof toolWriteReceipt> | undefined;
    if (after !== before) receipt = { kind: 'timeline', status: 'saved', revision: after };
    else if (declared && definition.effect === 'job') receipt = { kind: 'job', status: 'queued', revision: after };
    else if (declared && definition.effect === 'resource') receipt = { kind: 'resource', status: 'saved', revision: after };
    const stagedRevision = args.functionName === 'assistant:apply' && args.input.stagedPublication === true && typeof args.input.expectedRevision === 'number' ? args.input.expectedRevision : undefined;
    const serialized=JSON.stringify(convexToJson(value??null)).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')),partSize=100_000;
    // Frame and analysis results can exceed a document. Cache them in bounded
    // pieces so receipt persistence never introduces a new size limit on tools.
    const valueParts=serialized.length>partSize?Math.ceil(serialized.length/partSize):0;
    for(let part=0;part<valueParts;part++)await ctx.db.insert('toolWriteResultParts',{writeId:args.writeId,part,value:serialized.slice(part*partSize,(part+1)*partSize)});
    await ctx.db.insert('toolWriteReceipts', { projectId: args.projectId, ownerId: args.ownerId, runId: args.runId, writeId: args.writeId, toolName: args.toolName, functionName: args.functionName, ...(valueParts?{valueParts}:{value:value??null}),...(receipt?{receipt}:{}), ...(stagedRevision === undefined ? {} : { stagedRevision }), expiresAt: Date.now() + 86_400_000 });
    if(turn&&(receipt?.kind==='timeline'||args.functionName==='assistant:previewDraft')){
      const task=await ctx.db.query('editingLaneTasks').withIndex('by_task',q=>q.eq('taskId',args.runId)).unique();
      const afterPreview=args.functionName==='assistant:previewDraft'?await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',args.projectId)).unique():null;
      const beforeTimeline=beforePreview?.runId===args.runId&&beforePreview.baseRevision===before?beforePreview.timeline:beforeProject?.timeline;
      const afterTimeline=afterPreview?.runId===args.runId?afterPreview.timeline:afterProject?.timeline;
      const saved=task&&beforeTimeline?readFastFrameTimes(task.evidence,turn.timelineId,await timelineHistoryKey(beforeTimeline)):undefined;
      const review=new FastFrameReview(saved??turn.pendingFastFrames);
      if(beforeTimeline&&afterTimeline)review.changed(beforeTimeline,afterTimeline,task&&laneChecks(task.lane,taskCheckLevel(task)).frames==='sample'?fastReelFrameMoments(args.toolName,beforeTimeline,afterTimeline):undefined);
      if(task&&afterTimeline){
        const entry=fastFrameEvidence(turn.timelineId,await timelineHistoryKey(afterTimeline),review.times());
        await saveEvidence(ctx,task,entry);
      }
      await patchTurn(ctx,turn,{savedEdits:turn.savedEdits+(receipt?.kind==='timeline'?1:0),pendingFastFrames:review.times()});
    }
    return { value, replayed:false,...(receipt ? { receipt } : {}) };
  },
});

/** A dropped response can be reconciled without replaying the write. */
export const receipt = internalQuery({ args: { ...scope, writeId: v.string() }, returns: v.union(v.null(), toolWriteReceipt), handler: async (ctx, args) => {
  await projectIdentity(ctx, args.projectId, args.ownerId);
  const row = await ctx.db.query('toolWriteReceipts').withIndex('by_write', q => q.eq('writeId', args.writeId)).unique();
  return row && row.ownerId === args.ownerId && row.projectId === args.projectId && row.runId === args.runId ? row.receipt??null : null;
} });

export const prune = internalMutation({ args: {}, returns: v.null(), handler: async ctx => {
  const expired = await ctx.db.query('toolWriteReceipts').withIndex('by_expires', q => q.lt('expiresAt', Date.now())).take(20);
  for (const row of expired) {
    if(row.valueParts){
      const parts=await ctx.db.query('toolWriteResultParts').withIndex('by_write_part',q=>q.eq('writeId',row.writeId)).take(8);
      if(parts.length){for(const part of parts)await ctx.db.delete(part._id);await ctx.scheduler.runAfter(0,internal.toolWrites.prune,{});return null;}
    }
    await ctx.db.delete(row._id);
  }
  if(expired.length===20)await ctx.scheduler.runAfter(0,internal.toolWrites.prune,{});
  return null;
} });
