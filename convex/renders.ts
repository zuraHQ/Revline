import { recordIncident, incidentDeployment } from './lib/incidents';
import { deleteRenderSnapshot, saveRenderSnapshot } from './lib/render_snapshots';
import { clipExportTimeline } from '../lib/editor/clip-export';
import { activeTabOf, storedTabTimeline, tabsOf } from './timelineTabs';
import { hostedRendersEnabled, queuedExportLimit } from './lib/render_seats';
import { projectIdentity } from './lib/project_data';
import { forgetStorageObject } from './lib/storage_accounting';
import { internal } from './_generated/api';
import { hasUltraPlan, requireEditorAccess } from './lib/billing_access';
import { mediaDownloadUrl, mediaUrl } from './lib/media_storage';
import { ConvexError, v, type ObjectType } from "convex/values";
import { action, internalQuery, mutation, internalMutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { listLimit, requireOwner, requireProject } from "./lib/auth";
import { currentTimeline, validateTimeline } from "./lib/timeline";
import { renderSummaryDocument } from "./schema";
import { MAX_EXPORT_SECONDS } from '../lib/editor/limits';
import { timelineDuration } from '../lib/editor/types';
import { cancelMediaTask, enqueueMediaTask, failMediaTask } from './lib/media_queue';
import { accountLimit, consumeFairUse } from './lib/account_limits';import { sceneMediaAssetIds } from '../lib/editor/scene-layers';

const activeExportLimit = () => accountLimit('MAX_ACTIVE_EXPORTS_PER_ACCOUNT', 2, 1, 10);
const startRenderForArgs = { burnCaptions: v.optional(v.boolean()), projectId: v.id("projects"), resolution: v.number(), fps: v.number(), quality: v.string(), clipId:v.optional(v.string()), timelineId:v.optional(v.string()) };
export async function startRenderFor(ctx: MutationCtx, ownerId: string, args: ObjectType<typeof startRenderForArgs>) {
  await requireEditorAccess(ctx, ownerId); const project = await requireProject(ctx, args.projectId, ownerId);
  const ultra = await hasUltraPlan(ctx, ownerId);
  if (![720, 1080, ...(ultra ? [2160] : [])].includes(args.resolution) || ![24, 30, 60].includes(args.fps) || !["draft", "standard", "high"].includes(args.quality)) throw new ConvexError(args.resolution === 2160 ? "4K export is part of the Ultra plan." : "Invalid export settings");
  // A tab that is not open exports from its stored timeline.
  const tabs=tabsOf(project),tab=args.timelineId!==undefined?tabs.find(item=>item.id===args.timelineId):undefined;
  if(args.timelineId!==undefined&&!tab)throw new ConvexError('That timeline no longer exists.');
  const saved=tab?await storedTabTimeline(ctx,project,tab.id):currentTimeline(project);
  if(!saved)throw new ConvexError('That timeline no longer exists.');
  const timelineLabel=tabs.length>1?(tab??tabs.find(item=>item.id===activeTabOf(project)))?.name:undefined;
  if(args.clipId!==undefined&&project.aiRunning)throw new ConvexError('Wait for the current AI edit to finish before exporting this clip.');
  let snapshot=saved;
  if(args.clipId!==undefined){try{snapshot=clipExportTimeline(saved,args.clipId);}catch(error){throw new ConvexError((error as Error).message);}}
  if(args.burnCaptions === false) snapshot = {...snapshot, clips: snapshot.clips.filter(clip => clip.kind !== 'caption')};
  const timeline = await validateTimeline(ctx, project, snapshot); if (!timeline.clips.length) throw new ConvexError("Add a clip before exporting");
  if (timelineDuration(timeline) > MAX_EXPORT_SECONDS) throw new ConvexError("Exports currently support up to five minutes. Shorten the final edit before exporting; your full arrangement remains saved.");
  // Fair-use export minutes: metered here, capped only once FAIR_USE_MONTHLY.exportRenderMinutes is a number.
  await consumeFairUse(ctx, ownerId, 'exportRenderMinutes', Math.ceil(timelineDuration(timeline) / 60));
  // With hosted exports, seats bound concurrent renders; beyond them exports wait in a longer queue.
  const limit = hostedRendersEnabled() ? queuedExportLimit(ultra) : activeExportLimit();
  // The indexed reads and insert share one transaction, so separate projects
  // cannot race past the account's outstanding-work limit.
  const accountActive = await Promise.all((['queued', 'rendering'] as const).map(status => ctx.db.query('renderJobs').withIndex('by_owner_status', q => q.eq('ownerId', ownerId).eq('status', status)).take(limit)));
  if (accountActive.reduce((count, jobs) => count + jobs.length, 0) >= limit) throw new ConvexError(`You already have ${limit} exports in progress. Wait for one to finish or cancel it before exporting again.`);
  const assetIds: Id<"assets">[] = [];
  for (const assetId of [...timeline.clips.flatMap(clip => [...clip.assetId ? [clip.assetId] : [], ...clip.normalizedAudio ? [clip.normalizedAudio.assetId] : []]), ...sceneMediaAssetIds(timeline),...timeline.audioNormalization?[timeline.audioNormalization.assetId]:[]]) { const id = ctx.db.normalizeId("assets", assetId); if (id && !assetIds.includes(id)) assetIds.push(id); }
  const now = Date.now();
  const jobId = await ctx.db.insert("renderJobs", { ownerId, projectId: project._id, sourceRevision:project.revision??0, ...(args.clipId!==undefined?{sourceClipId:args.clipId}:{}), sourceTimelineId:tab?.id??activeTabOf(project), ...(timelineLabel?{label:timelineLabel}:{}), assetIds, resolution: args.resolution, fps: args.fps, quality: args.quality, status: "queued", progress: 0, createdAt: now, updatedAt: now }); await saveRenderSnapshot(ctx, jobId, timeline);
  // Ultra exports take the Ultra lane: dedicated Ultra export workers.
  const taskId = await enqueueMediaTask(ctx, { ownerId, projectId: project._id, kind: 'render', renderJobId: jobId, ...(ultra ? { lane: 'ultra' as const } : {}) });
  await ctx.db.patch(jobId, { taskId });
  return jobId;
}
export const start = mutation({ args: startRenderForArgs, returns: v.id("renderJobs"), handler: async (ctx, args) => startRenderFor(ctx, await requireOwner(ctx), args) });
export const cancel = mutation({ args:{jobId:v.id('renderJobs')},returns:v.null(),handler:async(ctx,args)=>{
  const ownerId=await requireOwner(ctx),job=await ctx.db.get(args.jobId);
  if(!job||job.ownerId!==ownerId)throw new ConvexError('Export not found');
  await requireProject(ctx,job.projectId,ownerId);
  if(job.status!=='queued'&&job.status!=='rendering')return null;
  if(job.taskId)await cancelMediaTask(ctx,job.taskId);
  await ctx.db.patch(job._id,{status:'cancelled',error:undefined,updatedAt:Date.now()});
  return null;
}});
// Worker leases recover disconnected renders, but nothing else ends an export
// that no renderer ever claims or one that keeps heartbeating without finishing.
const STALLED_QUEUE_MS = 30 * 60_000, STALLED_RENDER_MS = 2 * 3600_000;
const STALLED_QUEUE_ERROR = 'No renderer became available to start this export. Your saved edit is unchanged; try exporting again.';
const STALLED_RENDER_ERROR = 'This export took too long to finish and was stopped. Your saved edit is unchanged; try exporting again.';
export const failStalled = internalMutation({ args: {}, returns: v.null(), handler: async ctx => {
  const now = Date.now();
  // Only jobs older than the shorter limit can be stalled; few exports are active at once.
  for (const status of ['queued', 'rendering'] as const) {
    const jobs = await ctx.db.query('renderJobs').withIndex('by_status_createdAt', q => q.eq('status', status).lt('createdAt', now - STALLED_QUEUE_MS)).take(100);
    for (const job of jobs) {
      const task = job.taskId ? await ctx.db.get(job.taskId) : null;
      const active = task && ['queued', 'running', 'retrying'].includes(task.status) ? task : null;
      // Time the current attempt, or the current wait for a renderer.
      const running = active ? active.status === 'running' : status === 'rendering';
      const since = active ? running ? active.attemptStartedAt ?? active.updatedAt : active.updatedAt : job.updatedAt;
      if (now - since < (running ? STALLED_RENDER_MS : STALLED_QUEUE_MS)) continue;
      const error = running ? STALLED_RENDER_ERROR : STALLED_QUEUE_ERROR;
      if (active) await failMediaTask(ctx, active._id, error);
      const current = await ctx.db.get(job._id);
      if (current && (current.status === 'queued' || current.status === 'rendering')) {
        await recordIncident(ctx, { source: 'export', kind: 'export', message: error, context: { location: 'convex/renders:failStalled', jobId: job._id, taskKind: 'render' }, projectId: job.projectId, deployment: incidentDeployment() });
        await ctx.db.patch(job._id, { status: 'failed', error, updatedAt: now });
      }
    }
  }
  return null;
}});
export const get = query({ args: { jobId: v.id("renderJobs") }, returns: renderSummaryDocument, handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx); const job = await ctx.db.get(args.jobId); if (!job || job.ownerId !== ownerId) throw new ConvexError("Render not found");
  const {timeline:_timeline,...summary}=job; return { ...summary, url: await mediaUrl(ctx, { storageId: job.outputStorageId, r2Key: job.outputR2Key }) };
}});
export const downloadSource = internalQuery({
  args: { jobId: v.id('renderJobs') },
  returns: v.object({ storageId: v.optional(v.id('_storage')), r2Key: v.optional(v.string()), fileName: v.string() }),
  handler: async (ctx, { jobId }) => {
    const ownerId = await requireOwner(ctx), job = await ctx.db.get(jobId);
    if (!job || job.ownerId !== ownerId || job.status !== 'completed' || !job.outputStorageId && !job.outputR2Key) throw new ConvexError('Completed export not found');
    const project = await projectIdentity(ctx, job.projectId, ownerId);
    const saved = await ctx.db.get(project._id);
    return { storageId: job.outputStorageId, r2Key: job.outputR2Key, fileName: exportFileName(saved!.title, job.label) };
  },
});
export const download = action({
  args: { jobId: v.id('renderJobs') }, returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const source = await ctx.runQuery(internal.renders.downloadSource, args);
    const url = await mediaDownloadUrl(ctx, source, source.fileName);
    if (!url) throw new ConvexError('Export file not found');
    return url;
  },
});
export const list = query({ args: { projectId: v.id("projects"), limit: v.optional(v.number()) }, returns: v.array(renderSummaryDocument), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx); await projectIdentity(ctx,args.projectId,ownerId);
  const jobs = await ctx.db.query("renderJobs").withIndex("by_ownerId_projectId", q => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).order("desc").take(listLimit(args.limit));
  return await Promise.all(jobs.map(async job => {const {timeline:_timeline,...summary}=job;return { ...summary, url: await mediaUrl(ctx, { storageId: job.outputStorageId, r2Key: job.outputR2Key }) };}));
}});

/** The download name: the project title, plus the timeline name when the project has several. */
export function exportFileName(title: string, label?: string) {
  const base = title.replace(/\.mp4$/i, '');
  return `${label ? `${base} - ${label}` : base}.mp4`;
}

export async function removeOwnedExport(ctx:MutationCtx,ownerId:string,jobId:Id<'renderJobs'>) {
  const job=await ctx.db.get(jobId);
  if(!job||job.ownerId!==ownerId)throw new ConvexError('Export not found');
  if(job.status==='queued'||job.status==='rendering')throw new ConvexError('Wait for this export to finish');
  if(job.outputStorageId)await ctx.storage.delete(job.outputStorageId);
  if(job.outputR2Key)await ctx.scheduler.runAfter(0,internal.r2.deleteObject,{key:job.outputR2Key});
  await forgetStorageObject(ctx,ownerId,{storageId:job.outputStorageId,r2Key:job.outputR2Key});
  await deleteRenderSnapshot(ctx,job._id);await ctx.db.delete(job._id);return null;
}
