/** The media task queue: enqueue, fail and cancel tasks. Feature files import this core instead of
 *  the mediaTasks function file, whose result handlers import those feature files back. */
import type { WorkflowId } from '@convex-dev/workflow';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { geminiBillingUnavailable, usesGemini } from './gemini_billing';
import { insertMediaTask, patchMediaTask, scheduleCapacityAdmission } from './media_task_data';
import { hasMediaTaskCapacity } from './account_limits';
import { hydrateAsset } from './asset_analysis';
import { mediaWorkflow } from './workflows';
import { hasPreview, PREVIEW_VERSION } from './media_storage';
import { hostedRendersEnabled } from './render_seats';
import { BEAT_ANALYSIS_ENGINE } from '../../lib/media-analysis/beat-map';
import { MEDIA_PROCESSOR_VERSION } from '../../lib/media-analysis/processor-version';
import { failJob as failGenesisJob } from '../genesisJobs';

/** The oldest media processor that can run each kind; older processors leave these tasks queued. */
// Rendered work shares the current clipping, montage VFX and streamed tracking contract.
const MIN_PROCESSOR_VERSION: Partial<Record<Doc<'mediaTasks'>['kind'], number>> = { highlights:MEDIA_PROCESSOR_VERSION,beats:MEDIA_PROCESSOR_VERSION,import:MEDIA_PROCESSOR_VERSION, facecam:MEDIA_PROCESSOR_VERSION, speakers:MEDIA_PROCESSOR_VERSION, transcribe: MEDIA_PROCESSOR_VERSION, frames: 4, preview:MEDIA_PROCESSOR_VERSION, cutout: MEDIA_PROCESSOR_VERSION, derive: 9, render: MEDIA_PROCESSOR_VERSION, review: MEDIA_PROCESSOR_VERSION, snapshot: MEDIA_PROCESSOR_VERSION, blueprint: 11, reference: 12, read: MEDIA_PROCESSOR_VERSION };

export async function enqueueMediaTask(ctx: MutationCtx, input: Pick<Doc<'mediaTasks'>, 'ownerId' | 'projectId' | 'kind'> & Partial<Pick<Doc<'mediaTasks'>, 'assetId' | 'renderJobId' | 'analysisRequestId' | 'sourceUrl' | 'importRange' | 'sourcesOnly' | 'frameRequest' | 'videoRequest' | 'highlightSourceType' | 'highlightSkipGemini' | 'speakerRequest' | 'reviewId' | 'snapshotId' | 'readId' | 'blueprintCheckId' | 'cutoutId' | 'derivationId' | 'genesisJobId' | 'requiredProcessorVersion'|'previewVersion'|'lane'>>, beforeEnqueue?:()=>Promise<void>, waitForCapacity = false): Promise<Id<'mediaTasks'>> {
  const minimum = usesGemini(input.kind) ? MEDIA_PROCESSOR_VERSION : MIN_PROCESSOR_VERSION[input.kind];
  if (minimum) input = { ...input, requiredProcessorVersion: Math.max(minimum, input.requiredProcessorVersion ?? 0) };
  if(input.kind==='preview')input={...input,previewVersion:PREVIEW_VERSION};
  if(input.assetId&&input.kind==='preview'){const asset=await ctx.db.get(input.assetId);// A cut-out plays its own VP9 alpha file; an H.264 proxy would drop the transparency.
  if(asset?.ownerId===input.ownerId&&asset.projectId===input.projectId&&(hasPreview(asset)||asset.cutoutOf||asset.derivedOf)){const now=Date.now();return insertMediaTask(ctx,{...input,status:'completed',attempt:0,progress:100,createdAt:now,updatedAt:now});}}
  if (input.assetId && input.kind === 'beats') {
    const asset = await ctx.db.get(input.assetId);
    const beats=asset?(await hydrateAsset(ctx,asset)).analysis?.beats:undefined;
    if (asset?.ownerId === input.ownerId && asset.projectId === input.projectId && beats?.engine === BEAT_ANALYSIS_ENGINE && beats.downbeats !== undefined && beats.accents !== undefined && beats.dropCandidates !== undefined && beats.energy !== undefined) {
      const now = Date.now();
      const taskId = await insertMediaTask(ctx, { ...input, status: 'completed', attempt: 0, progress: 100, createdAt: now, updatedAt: now });
      if (input.analysisRequestId) await ctx.db.patch(input.analysisRequestId, { status: 'completed', error: undefined });
      return taskId;
    }
  }
  // Each frame read, cut-out and derivation is its own request with its own result row: parallel ones on one asset each get a task.
  if (input.assetId && input.kind !== 'speakers' && input.kind !== 'frames' && input.kind !== 'video' && input.kind !== 'cutout' && input.kind !== 'derive' && input.kind !== 'read' && input.kind !== 'genesis') {
    const existing = await ctx.db.query('mediaTasks').withIndex('by_asset_kind', q => q.eq('assetId', input.assetId).eq('kind', input.kind)).order('desc').take(10);
    const active = existing.find(task => (input.kind!=='preview'||task.previewVersion===input.previewVersion)&&['queued','running','retrying'].includes(task.status));
    if(active&&input.kind==='preview'&&(active.requiredProcessorVersion??0)<(input.requiredProcessorVersion??0))await cancelMediaTask(ctx,active._id);
    else if (active) { if (input.analysisRequestId) await ctx.db.patch(active._id, { analysisRequestId: input.analysisRequestId }); return active._id; }
  }
  const requested = input.kind === 'video' ? input.videoRequest : input.kind === 'frames' ? input.frameRequest : undefined;
  if(input.assetId&&requested){
    const existing=await ctx.db.query('mediaTasks').withIndex('by_asset_kind',q=>q.eq('assetId',input.assetId).eq('kind',input.kind)).order('desc').take(20);
    const reusable=existing.find(task=>{
      const inspection = input.kind === 'video' ? task.videoRequest : task.frameRequest;
      const evidence = input.kind === 'video' ? task.videoInspection : task.frameInspection;
      // Older frame workers returned prose only, which cannot position a camera.
      if (input.kind === 'frames' && ((task.requiredProcessorVersion ?? 1) < 4 || task.status === 'completed' && !task.frameInspection?.geometry)) return false;
      return task.ownerId===input.ownerId&&task.projectId===input.projectId&&inspection?.question===requested.question&&inspection.start===requested.start&&inspection.end===requested.end&&((task.status==='completed'&&!!evidence)||['queued','running','retrying'].includes(task.status));
    });
    if(reusable){
      if(input.analysisRequestId){
        if(reusable.status==='completed')await ctx.db.patch(input.analysisRequestId,{status:'completed',...(input.kind==='video'?{videoInspection:reusable.videoInspection}:{frameInspection:reusable.frameInspection}),error:undefined});
        else {
          await ctx.db.patch(reusable._id,{analysisRequestId:input.analysisRequestId});
          if(reusable.status==='running')await ctx.db.patch(input.analysisRequestId,{status:'running'});
        }
      }
      return reusable._id;
    }
  }
  // Reused evidence and active tasks need no new provider capacity. Reserve
  // only when a fresh task will actually be inserted, in this transaction.
  const billingReason = usesGemini(input.kind) ? await geminiBillingUnavailable(ctx, input.ownerId) : null;
  if (billingReason) {
    if (input.kind === 'highlights') input = { ...input, highlightSkipGemini: billingReason };
    else {
      const now = Date.now();
      const taskId = await insertMediaTask(ctx, { ...input, status: 'failed', error: billingReason, attempt: 0, progress: 0, createdAt: now, updatedAt: now });
      await markTerminal(ctx, taskId, 'failed', billingReason);
      return taskId;
    }
  }
  await beforeEnqueue?.();
  const now = Date.now();
  const earlier = waitForCapacity && await ctx.db.query('mediaTasks').withIndex('by_owner_capacity_waiting', q => q.eq('ownerId', input.ownerId).eq('capacityWaiting', true)).first();
  const capacityWaiting = waitForCapacity && (!!earlier || !await hasMediaTaskCapacity(ctx, input.ownerId, 1));
  const taskId = await insertMediaTask(ctx, { ...input, status: 'queued', claimable:false, ...(capacityWaiting ? { capacityWaiting: true, capacityQueued: true } : {}), attempt: 0, progress: 0, createdAt: now, updatedAt: now });
  if (capacityWaiting) {
    await scheduleCapacityAdmission(ctx, input.ownerId);
    await ctx.scheduler.runAfter(120_000, internal.mediaTasks.expireWaiting, { taskId });
    return taskId;
  }
  const workflowId = await mediaWorkflow.start(ctx, internal.mediaTasks.process, { taskId }, { startAsync: true, onComplete: internal.mediaTasks.settle, context: { taskId } });
  await ctx.db.patch(taskId, { workflowId });
  return taskId;
}
/** A finished or failed export frees one of its owner's seats; let a waiting export take it. */
export async function releaseRenderSeat(ctx: MutationCtx, task: Doc<'mediaTasks'>) {
  if (task.kind === 'render' && hostedRendersEnabled()) await ctx.scheduler.runAfter(0, internal.railwayWorkers.dispatch, {});
}
export async function markTerminal(ctx: MutationCtx, taskId: Id<'mediaTasks'>, status: 'failed' | 'cancelled', error: string) {
  const task = await ctx.db.get(taskId);
  // A workflow cancelled after a permanent failure must not hide its reason.
  if (!task || task.status === 'completed' || task.status === 'cancelled' || (status === 'cancelled' && task.status === 'failed')) return;
  await patchMediaTask(ctx, task, { status, error: error.slice(0, 1000), leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() });
  await releaseRenderSeat(ctx, task);
  if (task.renderJobId) {
    const job = await ctx.db.get(task.renderJobId);
    if (job && job.status !== 'completed' && job.status !== 'cancelled') await ctx.db.patch(job._id, { status: status==='cancelled'?'cancelled':'failed', error: status==='cancelled'?undefined:error.slice(0, 1000), updatedAt: Date.now() });
  }
  if(task.reviewId){const review=await ctx.db.get(task.reviewId);if(review)await ctx.db.patch(review._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.snapshotId){const thumb=await ctx.db.query('sceneThumbnails').withIndex('by_snapshot',q=>q.eq('snapshotId',task.snapshotId!)).unique();if(thumb&&thumb.status==='queued')await ctx.db.patch(thumb._id,{status:'failed'});const snapshot=await ctx.db.get(task.snapshotId);if(snapshot&&snapshot.status==='queued')await ctx.db.patch(snapshot._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.readId){const read=await ctx.db.get(task.readId);if(read&&read.status==='queued')await ctx.db.patch(read._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.blueprintCheckId){const check=await ctx.db.get(task.blueprintCheckId);if(check&&check.status==='queued')await ctx.db.patch(check._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.cutoutId){const cutout=await ctx.db.get(task.cutoutId);if(cutout&&cutout.status==='queued')await ctx.db.patch(cutout._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.derivationId){const row=await ctx.db.get(task.derivationId);if(row&&row.status==='queued')await ctx.db.patch(row._id,{status:'failed',error:error.slice(0,1000)});}
  if(task.genesisJobId)await failGenesisJob(ctx,task,error);
  if (task.analysisRequestId) {
    const request = await ctx.db.get(task.analysisRequestId);
    if (request) await ctx.db.patch(request._id, { status: 'failed', error: error.slice(0, 1000) });
  }
}
/** Fails an unfinished task permanently and stops its workflow. */
export async function failMediaTask(ctx: MutationCtx, taskId: Id<'mediaTasks'>, error: string) {
  const task = await ctx.db.get(taskId);
  if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return;
  await markTerminal(ctx, taskId, 'failed', error);
  if (task.workflowId) await mediaWorkflow.cancel(ctx, task.workflowId as WorkflowId);
}
export async function cancelMediaTask(ctx: MutationCtx, taskId: Id<'mediaTasks'>) {
  const task = await ctx.db.get(taskId);
  if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return;
  await markTerminal(ctx, taskId, 'cancelled', 'Processing cancelled.');
  if (task.workflowId) await mediaWorkflow.cancel(ctx, task.workflowId as WorkflowId);
}
/** A bounded action wait ending must not discard already-running analysis. Stop
 * cancels its tasks separately before deleting their requests. */
export async function detachAnalysisRequest(ctx:MutationCtx,request:Doc<'analysisRequests'>){
  const task=request.taskId?await ctx.db.get(request.taskId):null;
  if(task?.analysisRequestId===request._id&&task.ownerId===request.ownerId&&task.projectId===request.projectId&&task.assetId===request.assetId&&['queued','running','retrying'].includes(task.status))await patchMediaTask(ctx, task,{analysisRequestId:undefined});
  await ctx.db.delete(request._id);
}
