import { customMutation } from 'convex-helpers/server/customFunctions';
import { persistVideoUnavailable } from './lib/video_unavailable';
import { projectWorkingAgents, workingAgentValidator } from './mcpConnections';
import { patchTurn, turnSummaryForRun, settleTurn } from './lib/assistant_turn_data';
import { recordIncident, incidentDeployment } from './lib/incidents';
import { MAX_SPEAKER_WINDOW_SECONDS } from '../lib/media-analysis/clipping';
import {parseEditorCommand} from '../lib/ai/slash-commands';
import {editorEditModeValidator} from './lib/edit_mode';
import { chatAgent, createMessageHistory, listMessageViews } from './lib/chat_data';
import {validatePinnedClaudeModel,type ClaudeModelSelection,type ClaudeModelChoice} from '../lib/ai/claude-model';
import { READ_ONLY_RUN_PREFIX, mcpRunTab, boundRunTab, isMcpRun, runAuthorLabel } from './lib/run_ids';
import { runArgs, holdsRun, runIsActive } from './lib/active_run';
import { approvalRefusal, approvalViolations, isApproved } from '../lib/editor/approvals';
import type {MutationCtx, QueryCtx} from './_generated/server';
import type {Doc} from './_generated/dataModel';
import {cancelTurn} from './assistantWorkflow';
import {stopRunnerTurn} from './lib/runner_turns';
import {dispatchTurn,rememberTurn,turnForRun} from './assistantTurnRecovery';
import type {WorkflowId} from '@convex-dev/workflow';
import { describeLiveEdit } from '../lib/editor/live-edit';
import { clearFilmDrafts } from './filmDrafts';
import { equalTimelineValue } from '../lib/editor/timeline-equality';
import { transportAsset, storeAnalysis } from './lib/asset_analysis';
import { attachStockAudio, validateWaveform } from './assets';
import { recordAssetStorage } from './lib/storage_accounting';
import { projectMediaPrefix } from './lib/media_storage';
import { writeProject,readProject,projectIdentity,projectRun,projectRunContext,runPayload,writeRunState } from './lib/project_data';
import { loadSceneCode, storeSceneCode, storedSceneCode } from './lib/scene_code';
import { importVideoFor } from './mediaTasks';
import { startRenderFor } from './renders';
import { activeTabOf, createTabFor, listTabsFor, openTabFor, storedTabTimeline, tabsOf } from './timelineTabs';
import { withoutSceneCode } from '../lib/editor/scene-code';
import { activeAppleEntitlement } from './lib/apple_entitlements';
import { hasPaidModelAccess, requireEditorAccess, requireInAppAgentAccess, requireRunPlan } from './lib/billing_access';
import { abortStream, createThread, listStreams, listUIMessages, saveMessage, syncStreams, vPaginationResult, vStreamArgs } from "@convex-dev/agent";
import { vStreamDelta, vStreamMessage } from "@convex-dev/agent/validators";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { PROJECT_MEDIA_LIMIT } from "../lib/editor/limits";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOwner, requireProject } from "./lib/auth";
import { commitTimeline, currentTimeline, rejectNewLayerOverlaps, validateTimeline } from "./lib/timeline";
import { TIMELINE_CONFLICT } from "../lib/editor/timeline-sync";
import { highlightSourceTypeValidator, speakerRequestValidator, analysisMode, analysisRequestDocument, assetDocument, waveformValidator, beatsValidator, transcriptValidator, clipValidator, frameRequestValidator, videoRequestValidator, projectDocument, timelineValidator } from "./schema";
import { validateFrameInspectionInput } from '../lib/media-analysis/frame-inspection';
import { validateVideoInspectionInput } from '../lib/media-analysis/video-inspection';
import { normalizeTimeline } from '../lib/editor/types';
import {savePublicationReceipt} from './lib/publicationReceipt';
import { finishIncidentRun, publishIncidentRun } from './lib/save_incidents';
import { enqueueMediaTask, cancelMediaTask, detachAnalysisRequest } from './lib/media_queue';
import { consumeAssistantRequest, consumeAudioRequest, consumeFairUse, requireMediaTaskCapacity } from './lib/account_limits';
import { FREE_EDITOR_MODEL_CHOICE, EDITOR_PROVIDER_REASON, allowedClaudeModelChoices, enforceClaudeModelPolicy, freeEditorModel, assertEditorModelConfigured, claudeModelSwitcherEnabled, defaultEditorModelChoice, defaultEditorReasoningEffort, normalizeEditorReasoningEffort, resolveClaudeModel, withEditorReasoning, withEditorSpeed } from '../lib/ai/claude-model';
import { claudeModelChoiceValidator, legacyCompatibleModelChoiceValidator, editorReasoningEffortValidator, storedEditorReasoningEffortValidator, editorSpeedModeValidator, pinnedClaudeModelValidator } from './lib/claude_model';
import { assistantRecovery } from './lib/assistant_recovery';
import { mediaTaskActivityLabel } from '../lib/media-analysis/activity';
import { editingWorkflowActive } from './lib/assistant_workflow';
import { clipChangeAfter, historyStart, listRevisions, tabChangesAfter } from './lib/revision_log';
import { sceneCodeSource } from '../lib/editor/scene-code-edits';
import { sceneCodeDiff } from '../lib/editor/scene-code-diff';
const mobileModel = () => withEditorReasoning(enforceClaudeModelPolicy(resolveClaudeModel(FREE_EDITOR_MODEL_CHOICE)), 'medium');
function configured(paidModelAccess = true) {
  try{assertEditorModelConfigured(paidModelAccess ? resolveClaudeModel() : freeEditorModel());return true;}catch{return false;}
}
/** Paid accounts can choose any configured model. Null when the switcher is off. */
function editorModelChoices() {
  if (!claudeModelSwitcherEnabled()) return null;
  return allowedClaudeModelChoices();
}
function canChooseEditorModel(modelChoice?: string) {
  const choices = editorModelChoices();
  return !!choices && (modelChoice === undefined || choices.some(choice => choice === modelChoice));
}
const composerSettingsFields = {
  modelAccessNeedsSync: v.optional(v.boolean()),
  paidModelAccess: v.optional(v.boolean()),
  modelSwitcher: v.optional(v.boolean()),
  catalogModels: v.optional(v.array(claudeModelChoiceValidator)),
  allowedModels: v.optional(v.array(claudeModelChoiceValidator)),
  claudeViaMcp: v.optional(v.boolean()),
  defaultModelChoice: v.optional(claudeModelChoiceValidator),
  defaultReasoningEffort: v.optional(editorReasoningEffortValidator),
  effortSwitcher: v.optional(v.boolean()),
};
async function editorComposerSettings(ctx: QueryCtx, ownerId: string) {
  const paidModelAccess = await hasPaidModelAccess(ctx, ownerId);
  const catalogModels = [...allowedClaudeModelChoices()];
  const apple = !paidModelAccess ? await activeAppleEntitlement(ctx, ownerId) : null;
  if (!paidModelAccess) return { catalogModels, modelAccessNeedsSync: !!apple && apple.modelPayment === undefined, paidModelAccess: false, claudeViaMcp: false, modelSwitcher: true, effortSwitcher: true, allowedModels: [FREE_EDITOR_MODEL_CHOICE] satisfies ClaudeModelChoice[], defaultModelChoice: FREE_EDITOR_MODEL_CHOICE, defaultReasoningEffort: 'low' as const };
  let defaultModelChoice; try { defaultModelChoice = defaultEditorModelChoice(); } catch {}
  const choices = editorModelChoices();
  return {
    paidModelAccess,
    catalogModels,
    modelAccessNeedsSync: false,
    ...(defaultModelChoice ? { defaultModelChoice } : {}),
    defaultReasoningEffort: defaultEditorReasoningEffort(),
    ...(choices ? { modelSwitcher: true, allowedModels: [...choices] } : {}),
    claudeViaMcp: false,
    ...(process.env.EDITOR_EFFORT_SWITCHER === 'true' && choices ? { effortSwitcher: true } : {}),
  };
}
export const composerSettings = query({
  args: {}, returns: v.object(composerSettingsFields),
  handler: async ctx => editorComposerSettings(ctx, await requireOwner(ctx)),
});
export const status = query({ args: { projectId: v.id("projects"), clientPlatform: v.optional(v.literal("ios")) }, returns: v.object({ ...composerSettingsFields, configured: v.boolean(), mobileConfigured: v.optional(v.boolean()), running: v.boolean(), externalAgents: v.array(workingAgentValidator), externalAgent: v.union(v.object({ name: v.string(), until: v.number(), running: v.boolean() }), v.null()), editing: v.boolean(), workflowActive: v.boolean(), error: v.union(v.string(), v.null()), reason: v.union(v.string(), v.null()), activity: v.union(v.string(), v.null()), activitySource: v.union(v.string(), v.null()), activityProgress: v.union(v.number(), v.null()), activityStartedAt: v.union(v.number(), v.null()), budgetUsed: v.optional(v.number()), liveEffort: v.optional(editorReasoningEffortValidator) }), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx), project = await projectRun(ctx,args.projectId,ownerId);
  // The original user message survives retries, including legacy requests whose
  // recovery turn was only created on retry. Read the small turn view first.
  const turn = project.aiRunning && project.aiRunId ? await turnSummaryForRun(ctx, project.aiRunId) : null;
  const [prompt] = turn?.projectId === project._id ? await ctx.runQuery(components.agent.messages.getMessagesByIds, { messageIds: [turn.promptMessageId] }) : [];
  const requestStartedAt = prompt && prompt.threadId === project.threadId && prompt.message?.role === 'user' ? prompt._creationTime : turn?.legacy?._creationTime ?? null;
  const requests = project.aiRunning && project.aiRunId ? await ctx.db.query('analysisRequests').withIndex('by_projectId_runId', q => q.eq('projectId', project._id).eq('aiRunId', project.aiRunId!)).take(16) : [];
  const active = requests.find(request => request.status === 'pending' || request.status === 'running');
  const task = active?.taskId ? await ctx.db.query('mediaTaskViews').withIndex('by_task',q=>q.eq('taskId',active.taskId!)).unique() : null;
  const source = active ? await ctx.db.get(active.assetId) : null;
  const labels = { highlights:'Finding highlights…',facecam:'Finding the facecam…', speakers:'Following active speakers…', transcribe: 'Listening to your footage…', understand: 'Analyzing footage…', shots: 'Finding shot changes…', beats: 'Finding the rhythm…', track: 'Following the subject…', reference: 'Breaking down the reference…', frames: 'Inspecting the moment…', video: 'Analyzing footage…' };
  const settings = await editorComposerSettings(ctx, ownerId);
  const ready=!settings.paidModelAccess ? configured(false) : args.clientPlatform==='ios'?(()=>{try{assertEditorModelConfigured(mobileModel());return true;}catch{return false;}})():configured();
  const editing=!!project.aiRunning&&(project.aiEditing??project.aiUndoRecorded??false);
  // Run-scoped analysis remains evidence of the editing workflow while the
  // model plans its next step; a plain reply never acquires this workflow lock.
  const workflowActive=await editingWorkflowActive(ctx,project,requests.length>0);
  // The row outlives its run so the development effort switcher can show the last pick.
  const budgetRow=await ctx.db.query('aiBudgets').withIndex('by_project',q=>q.eq('projectId',project._id)).unique();
  const budget=project.aiRunning&&project.aiRunId?budgetRow:null;
  const activity=active?task?.status==='retrying'||task?.status==='queued'&&(task.attempt>1)?'Retrying analysis…':task?.status==='queued'?'Queued for analysis…':task&&(task.activity||task.kind==='transcribe')?mediaTaskActivityLabel(task):labels[active.mode]:editing?'Applying edits…':null;
  const externalAgents=await projectWorkingAgents(ctx,ownerId,project._id), latestAgent=externalAgents[0];
  return { configured: ready, mobileConfigured:(()=>{try{assertEditorModelConfigured(mobileModel());return true;}catch{return false;}})(), ...settings, running: project.aiRunning ?? false, externalAgents, externalAgent: latestAgent ? { name: latestAgent.name, until: latestAgent.until, running: !!project.aiRunning && isMcpRun(project.aiRunId) } : null, editing, workflowActive, error: project.aiError ?? null, reason: ready ? null : EDITOR_PROVIDER_REASON, activity, activityProgress: null, activityStartedAt: requestStartedAt, activitySource: source?.ownerId === project.ownerId && source.projectId === project._id ? source.fileName : null, ...(budget&&budget.runId===project.aiRunId?{budgetUsed:budget.used}:{}), ...(budgetRow?.effort?{liveEffort:normalizeEditorReasoningEffort(budgetRow.effort)}:{}) };
}});
const livePreviewValidator = v.object({runId:v.string(),baseRevision:v.number(),timeline:timelineValidator,label:v.string(),changedClipIds:v.array(v.string()),removedClips:v.array(clipValidator),at:v.number(),sequence:v.number(),updatedAt:v.number()});
/** `sceneCode: 'refs'` keeps scene code by hash for editors that load each code once. */
export const livePreview = query({args:{projectId:v.id('projects'),sceneCode:v.optional(v.literal('refs'))},returns:v.union(v.null(),livePreviewValidator),handler:async(ctx,{projectId,sceneCode})=>{
  const run=await projectRunContext(ctx,projectId,await requireOwner(ctx));
  if(!run.aiRunning)return null;
  const preview=await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',projectId)).unique();
  if(!preview||preview.ownerId!==run.ownerId||preview.runId!==run.aiRunId||preview.baseRevision!==run.revision)return null;
  const {_id,_creationTime,ownerId,projectId:_,...result}=preview;
  if(sceneCode==='refs')return result;
  return {...result,timeline:await loadSceneCode(ctx,result.timeline),removedClips:(await loadSceneCode(ctx,{clips:result.removedClips})).clips};
}});
async function clearLivePreview(ctx:import('./_generated/server').MutationCtx,projectId:import('./_generated/dataModel').Id<'projects'>){
  await clearFilmDrafts(ctx,projectId);
  const preview=await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',projectId)).unique();
  if(preview)await ctx.db.delete(preview._id);
}
export const send = mutation({ args: { projectId: v.id("projects"), prompt: v.string(), clientPlatform: v.optional(v.literal("ios")), modelChoice: v.optional(legacyCompatibleModelChoiceValidator), reasoningEffort: v.optional(storedEditorReasoningEffortValidator), speedMode: v.optional(editorSpeedModeValidator), // Older clients still send editMode; it validates and is ignored. The lane sets the checks.
  editMode: v.optional(editorEditModeValidator), attachedAssetIds:v.optional(v.array(v.id('assets'))), selectedClipId: v.optional(v.string()), selectedClipIds: v.optional(v.array(v.string())), playhead: v.optional(v.number()), timelineId: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
  const ownerId = await requireOwner(ctx); await requireInAppAgentAccess(ctx, ownerId); const project = await requireProject(ctx, args.projectId, ownerId);
  const paidModelAccess = await hasPaidModelAccess(ctx, ownerId);
  const mobile = args.clientPlatform === 'ios';
  if(mobile){const user=await ctx.db.query('users').withIndex('by_clerk_id',q=>q.eq('clerkId',ownerId)).unique();if(user?.aiConsentVersion!==1)throw new ConvexError('Review and allow AI data sharing before editing.');}
  if (mobile && (args.modelChoice !== FREE_EDITOR_MODEL_CHOICE || args.reasoningEffort !== 'medium' || args.speedMode !== undefined)) throw new ConvexError('iPhone editing uses GPT-6.1 Terra with medium reasoning.');
  const manualEffort = args.reasoningEffort !== undefined && args.reasoningEffort !== 'auto';
  if (paidModelAccess && !mobile && (args.modelChoice !== undefined || manualEffort || args.speedMode !== undefined) && !canChooseEditorModel(args.modelChoice)) throw new ConvexError('This AI model is not available.');
  let pinnedModel;
  try { pinnedModel = !paidModelAccess ? freeEditorModel() : mobile ? mobileModel() : withEditorSpeed(withEditorReasoning(enforceClaudeModelPolicy(resolveClaudeModel(args.modelChoice)), args.reasoningEffort), args.speedMode); assertEditorModelConfigured(pinnedModel); } catch (error) { throw new ConvexError((error as Error).message); }
  if(args.attachedAssetIds){
    if(args.attachedAssetIds.length>20||new Set(args.attachedAssetIds).size!==args.attachedAssetIds.length)throw new ConvexError('Attach up to 20 unique media files.');
    for(const id of args.attachedAssetIds){const asset=await ctx.db.get(id);if(!asset||asset.ownerId!==ownerId||asset.projectId!==project._id)throw new ConvexError('Attached media does not belong to this project.');}
  }
  const clipIds = new Set((await requestTimeline(ctx, project, args.timelineId)).clips.map(clip => clip.id));
  if(project.aiRunning&&!sentFromOtherTab(project,args.timelineId)){const preview=await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',project._id)).unique();if(preview?.ownerId===ownerId&&preview.runId===project.aiRunId)for(const clip of preview.timeline.clips)clipIds.add(clip.id);}
  if (args.selectedClipId !== undefined && !clipIds.has(args.selectedClipId)) throw new ConvexError("Selected clip does not belong to this project");
  if (args.selectedClipIds) {
    if (args.selectedClipIds.length > 200) throw new ConvexError("Select at most 200 clips");
    if (new Set(args.selectedClipIds).size !== args.selectedClipIds.length) throw new ConvexError("Selected clips must be unique");
    if (args.selectedClipIds.some(id => !clipIds.has(id))) throw new ConvexError("Selected clips must belong to this project");
  }
  if (args.playhead !== undefined && (!Number.isFinite(args.playhead) || args.playhead < 0)) throw new ConvexError("Playhead must be a finite, nonnegative time");
  if (!mobile && !configured(paidModelAccess)) throw new ConvexError(EDITOR_PROVIDER_REASON);
  const prompt = args.prompt.trim(); if (!prompt || prompt.length > 8000) throw new ConvexError("Write a prompt between 1 and 8000 characters");
  let command: ReturnType<typeof parseEditorCommand>;
  try { command = parseEditorCommand(prompt); } catch (error) { throw new ConvexError(error instanceof Error ? error.message : 'Invalid command.'); }
  const queued=await ctx.db.query('assistantQueue').withIndex('by_project',q=>q.eq('projectId',project._id)).first();
  if(project.aiRunning||queued){
    const pending=await ctx.db.query('assistantQueue').withIndex('by_project',q=>q.eq('projectId',project._id)).take(10);
    if(pending.length>=10)throw new ConvexError('You can queue up to 10 messages. Remove one before adding more.');
    await consumeAssistantRequest(ctx,ownerId);
    const {prompt:_,projectId:__,modelChoice:___,reasoningEffort:____,speedMode:_____,editMode:_legacyEditMode,...context}=args;
    await ctx.db.insert('assistantQueue',{projectId:project._id,ownerId,prompt,pinnedModel,...context,...(command?{command}:{}),createdAt:Date.now()});
    if(!project.aiRunning&&!project.aiQueuePaused)await ctx.scheduler.runAfter(0,internal.assistant.drainQueue,{projectId:project._id,ownerId});
    return null;
  }
  await consumeAssistantRequest(ctx,ownerId);
  return beginRequest(ctx,project,prompt,pinnedModel,{...args,...(command?{command}:{})});
}});
type QueuedContext=Pick<Doc<'assistantQueue'>,'command'|'attachedAssetIds'|'selectedClipId'|'selectedClipIds'|'playhead'|'timelineId'>;
/** Retry is a continuation of an existing prompt; it never writes a user message. */
export const retry = mutation({args:{projectId:v.id('projects'),promptMessageId:v.string()},returns:v.null(),handler:async(ctx,args)=>{
  const ownerId=await requireOwner(ctx);await requireInAppAgentAccess(ctx,ownerId);
  const project=await requireProject(ctx,args.projectId,ownerId);
  const [prompt]=await ctx.runQuery(components.agent.messages.getMessagesByIds,{messageIds:[args.promptMessageId]});
  if(!prompt||prompt.threadId!==project.threadId||prompt.message?.role!=='user')throw new ConvexError('The original request is no longer available in this conversation.');
  const turn=await ctx.db.query('assistantTurns').withIndex('by_prompt',q=>q.eq('projectId',args.projectId).eq('promptMessageId',args.promptMessageId)).unique();
  if(project.aiRunning){if(turn?.runId===project.aiRunId)return null;throw new ConvexError('Wait for the current request before resuming this one.');}
  if(turn?.status==='completed')return null;
  await consumeAssistantRequest(ctx,ownerId);
  const runId=crypto.randomUUID(),text=prompt.text??'';
  const recovery:Doc<'projects'>['aiRecovery']=turn?{requests:[text],runId:turn.runId,revision:project.revision??0,savedEdits:turn.savedEdits,status:'failed',reason:turn.feedback??project.aiError??'Resume the unfinished request.',updatedAt:Date.now()}:project.aiRecovery;
  const sameUndoGroup=turn?.runId===project.aiRunId&&project.aiCheckpointRevision===project.revision;
  const pinnedModel=await hasPaidModelAccess(ctx,ownerId)?validatePinnedClaudeModel(turn?.args.pinnedModel??resolveClaudeModel()):freeEditorModel();assertEditorModelConfigured(pinnedModel);
  if(turn?.timelineId&&turn.timelineId!==activeTabOf(project))await openTabFor(ctx,ownerId,{projectId:args.projectId,timelineId:turn.timelineId});
  const resumed={...(turn?.args??{}),projectId:args.projectId,ownerId,runId,threadId:prompt.threadId,promptMessageId:args.promptMessageId,pinnedModel,...(recovery?{recovery}:{}),continuation:{segment:0,repairPass:0,savedEdits:0,pendingFastFrames:turn?.pendingFastFrames??[],feedback:'Resume the original request in place. Inspect the saved timeline and finish only unfinished work; never repeat a completed edit.'}};
  await writeProject(ctx,project._id,{aiRunning:true,aiEditing:false,aiAgentName:undefined,aiAgentActiveUntil:undefined,aiRunId:runId,aiError:undefined,aiQueuePaused:false,aiWorkflowId:undefined,aiAnalysisUsage:{runId,enqueued:0},aiRequest:{prompt:text,messageId:args.promptMessageId,startedRevision:project.revision??0},...(!sameUndoGroup?{aiUndoRecorded:false,aiCheckpointRevision:undefined}:{})});
  if(turn)await patchTurn(ctx,turn,{runId,args:resumed,pass:0,segment:0,status:'running',error:undefined,savedEdits:0,feedback:resumed.continuation.feedback,updatedAt:Date.now()});
  else await rememberTurn(ctx,resumed,project);
  await dispatchTurn(ctx,resumed);
  return null;
}});
const sentFromOtherTab=(project:Doc<'projects'>,timelineId?:string)=>!!timelineId&&timelineId!==activeTabOf(project);
/** The timeline of the tab a request was sent from: the open tab, or another one the user was looking at. */
async function requestTimeline(ctx:MutationCtx,project:Doc<'projects'>,timelineId?:string){
  if(!sentFromOtherTab(project,timelineId))return currentTimeline(project);
  if(!tabsOf(project).some(tab=>tab.id===timelineId))throw new ConvexError('That timeline no longer exists. Open a timeline tab and send again.');
  return await storedTabTimeline(ctx,project,timelineId!)??currentTimeline(project);
}
async function beginRequest(ctx:MutationCtx,sent:Doc<'projects'>,prompt:string,pinnedModel:ClaudeModelSelection,request:QueuedContext):Promise<null>{
  // The turn works on the tab the user sent from. It opens here, in the transaction that takes the run lock,
  // and external tab changes stay locked until the turn ends. The run can open tabs for a clip batch.
  const switching=sentFromOtherTab(sent,request.timelineId)&&tabsOf(sent).some(tab=>tab.id===request.timelineId);
  if(switching)await openTabFor(ctx,sent.ownerId,{projectId:sent._id,timelineId:request.timelineId!});
  const project=switching?(await readProject(ctx,sent._id))!:sent;
  const ownerId=project.ownerId;
  const threadId = project.threadId ?? await createThread(ctx, components.agent, { userId: ownerId, title: project.title });
  if (!project.threadId) await createMessageHistory(ctx, threadId);
  await ctx.scheduler.runAfter(0, internal.assistantMessages.prepare, { threadId });
  const { messageId } = await saveMessage(ctx, chatAgent, { threadId, userId: ownerId, prompt });
  const recovery = project.aiRecovery ?? (project.aiError ? assistantRecovery(project, 'failed', project.aiError) : undefined);
  const runId = `${Date.now()}-${Math.random()}`;
  await clearLivePreview(ctx,project._id);
  await writeProject(ctx,project._id, { threadId, aiQueuePaused:false, aiRunning: true, aiEditing: false, aiAgentName:undefined, aiAgentActiveUntil:undefined, aiError: undefined, aiRunId: runId, aiAnalysisUsage:{runId,enqueued:0}, aiUndoRecorded: false, aiCheckpointRevision: undefined, aiRequest:{prompt,messageId,startedRevision:project.revision??0}, aiRecovery:recovery });
  const turn = { projectId: project._id, ownerId, runId, threadId, promptMessageId: messageId, pinnedModel,...(request.command?{command:request.command}:{}),...(request.attachedAssetIds?{attachedAssetIds:request.attachedAssetIds}:{}), ...(recovery?{recovery}:{}), ...(request.selectedClipId ? { selectedClipId: request.selectedClipId } : {}), ...(request.selectedClipIds ? { selectedClipIds: request.selectedClipIds } : {}), ...(request.playhead !== undefined ? { playhead: request.playhead } : {}) };
  await rememberTurn(ctx,turn,project);
  await dispatchTurn(ctx,turn);
  return null;
}

/** The agent stores large tool images in file storage and leaves a URL object behind, which a query cannot
 * return; send its address as text instead. */
function plainValues<T>(value: T): T {
  if (value instanceof URL) return value.href as T;
  if (Array.isArray(value)) return value.map(plainValues) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValues(item)])) as T;
  return value;
}

export const messages = query({
  args: { projectId: v.id("projects"), threadId: v.string(), paginationOpts: paginationOptsValidator, streamArgs: vStreamArgs },
  // AI SDK UI parts are polymorphic; agent validates and converts their stored representation.
  returns: v.object({ ...vPaginationResult(v.any()).fields, streams: v.union(v.object({ kind: v.literal("list"), messages: v.array(vStreamMessage) }), v.object({ kind: v.literal("deltas"), deltas: v.array(vStreamDelta) })) }),
  handler: async (ctx, args) => {
    const project = await projectIdentity(ctx,args.projectId,await requireOwner(ctx));
    if (args.paginationOpts.numItems < 0 || args.paginationOpts.numItems > 100 || (args.paginationOpts.numItems === 0 && !args.streamArgs)) throw new ConvexError("Message pages must contain between 1 and 100 messages");
    if (project.threadId && args.threadId !== project.threadId) throw new ConvexError("Conversation not found");
    if (!project.threadId) return { page: [], isDone: true, continueCursor: "", streams: args.streamArgs?.kind === "deltas" ? { kind: "deltas" as const, deltas: [] } : { kind: "list" as const, messages: [] } };
    const display = args.paginationOpts.numItems === 0 ? null : await ctx.db.query('assistantMessageThreads').withIndex('by_thread', q => q.eq('threadId', project.threadId!)).unique();
    const page = args.paginationOpts.numItems === 0 ? { page: [], isDone: true, continueCursor: "" } : display?.completed && (!args.paginationOpts.cursor || args.paginationOpts.cursor.startsWith('display:')) && (!args.paginationOpts.endCursor || args.paginationOpts.endCursor.startsWith('display:')) ? await listMessageViews(ctx, project.threadId, args.paginationOpts) : await listUIMessages(ctx, components.agent, { threadId: project.threadId, paginationOpts: args.paginationOpts });
    const streams = await syncStreams(ctx, components.agent, { threadId: project.threadId, streamArgs: args.streamArgs });
    const visible=await Promise.all(page.page.map(async message=>{if(message.role!=='user')return message;const view=await ctx.db.query('assistantTurnViews').withIndex('by_prompt',q=>q.eq('projectId',args.projectId).eq('promptMessageId',message.id)).unique();if(view)return {...message,turnState:view.status,turnError:view.error,turnResuming:view.resuming};const turn=await ctx.db.query('assistantTurns').withIndex('by_prompt',q=>q.eq('projectId',args.projectId).eq('promptMessageId',message.id)).unique();return turn?{...message,turnState:turn.status,turnError:turn.error,turnResuming:turn.status==='running'&&(turn.pass>0||!!turn.args.continuation)}:message;}));
    return { ...page, page: plainValues(visible), streams: streams ?? { kind: "list" as const, messages: [] } };
  },
});
// Both switches belong to one transaction: subscribers only see the original selection.
const scopedRunMutation = customMutation(internalMutation, {
  args: runArgs,
  input: async (ctx, args) => {
    const target = mcpRunTab(args.runId);
    const project = await requireProject(ctx, args.projectId, args.ownerId);
    const selected = activeTabOf(project);
    if (!target || target === selected) return { ctx: {}, args };
    await openTabFor(ctx, args.ownerId, { projectId: args.projectId, timelineId: target }, args.runId, true);
    return { ctx: {}, args, onSuccess: async () => {
      await clearLivePreview(ctx, args.projectId);
      await openTabFor(ctx, args.ownerId, { projectId: args.projectId, timelineId: selected }, args.runId, true);
    } };
  },
});

function settledAnalysisUsage(usage: Doc<'projects'>['aiAnalysisUsage']) {
  if (!usage?.videoUnavailable) return usage;
  const next = { ...usage };
  delete next.videoUnavailable;
  return next;
}
export const stop = mutation({ args: { projectId: v.id('projects') }, returns: v.null(), handler: async (ctx, args) => {
  const project = await requireProject(ctx, args.projectId, await requireOwner(ctx));
  return stopOwnedProject(ctx, project);
}});
export async function stopOwnedProject(ctx:MutationCtx, project:Doc<'projects'>) {
  if (!project.aiRunning) return null;
  if(project.aiRunId){const turn=await turnForRun(ctx,project.aiRunId);if(turn)await patchTurn(ctx,turn,{status:'stopped',updatedAt:Date.now()});}
  if (project.threadId) {
    const streams = await listStreams(ctx, components.agent, { threadId: project.threadId, includeStatuses: ['streaming'] });
    for (const stream of streams) await abortStream(ctx, components.agent, { streamId: stream.streamId, reason: 'Stopped by the user' });
  }
  if (project.aiRunId) {
    const requests = await ctx.db.query('analysisRequests').withIndex('by_projectId_runId', q => q.eq('projectId', project._id).eq('aiRunId', project.aiRunId!)).take(16);
    for (const request of requests) { if (request.taskId) await cancelMediaTask(ctx, request.taskId); await ctx.db.delete(request._id); }
  }
  const reviews=await ctx.db.query('compositionReviews').withIndex('by_project',q=>q.eq('projectId',project._id)).order('desc').take(2);
  for(const review of reviews)if(review.runId===project.aiRunId&&review.status==='queued'){if(review.taskId)await cancelMediaTask(ctx,review.taskId);await ctx.db.patch(review._id,{status:'failed',error:'Stopped by the user.'});}
  await clearLivePreview(ctx,project._id);
  // Already-saved edits remain undoable; invalidating the run blocks every later checkpoint.
  if(project.aiWorkflowId)await cancelTurn(ctx,project.aiWorkflowId as WorkflowId);
  if(project.aiRunId)await stopRunnerTurn(ctx,project.aiRunId);
  await writeProject(ctx,project._id, { aiRunning: false, aiEditing: false, aiRunId: undefined, aiWorkflowId:undefined, aiQueuePaused:true, aiError: undefined, aiRecovery:assistantRecovery(project,'stopped','Stopped by the user. Saved edits remain.'),aiRequest:undefined,aiAnalysisUsage:settledAnalysisUsage(project.aiAnalysisUsage) });
  if(project.threadId)await ctx.scheduler.runAfter(10_000,internal.assistantMessages.settleThread,{threadId:project.threadId,cursor:null});
  return null;
}
/** Begin the timeline lock only when a mutating tool has a real change to make. */
/** The effort the run is thinking at right now, for the development effort switcher. */
export const recordEffort = internalMutation({ args: { ...runArgs, effort: editorReasoningEffortValidator }, returns: v.null(), handler: async (ctx, args) => {
  const project = await projectRun(ctx,args.projectId,args.ownerId);
  if (!project.aiRunning || project.aiRunId !== args.runId) return null;
  const row = await ctx.db.query('aiBudgets').withIndex('by_project', q => q.eq('projectId', args.projectId)).unique();
  if (row) await ctx.db.patch(row._id, { runId: args.runId, ...(row.runId === args.runId ? {} : { used: 0 }), effort: args.effort, updatedAt: Date.now() });
  else await ctx.db.insert('aiBudgets', { projectId: args.projectId, runId: args.runId, used: 0, effort: args.effort, updatedAt: Date.now() });
  return null;
}});
export const recordBudget = internalMutation({ args: { ...runArgs, used: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const project = await projectRun(ctx,args.projectId,args.ownerId);
  if (!project.aiRunning || project.aiRunId !== args.runId || !Number.isFinite(args.used)) return null;
  const used = Math.min(1, Math.max(0, args.used)), row = await ctx.db.query('aiBudgets').withIndex('by_project', q => q.eq('projectId', args.projectId)).unique();
  if (row) await ctx.db.patch(row._id, { runId: args.runId, used, updatedAt: Date.now() });
  else await ctx.db.insert('aiBudgets', { projectId: args.projectId, runId: args.runId, used, updatedAt: Date.now() });
  return null;
}});
async function requireRunState(ctx: QueryCtx | MutationCtx, args: {projectId:Doc<'projects'>['_id'];ownerId:string;runId:string}) {
  const project=await projectRun(ctx,args.projectId,args.ownerId);
  if(!holdsRun(project,args.runId))throw new ConvexError('AI run is no longer active');
  return project;
}
/** Project tools used inside an existing editor run keep its lock and ownership checks. */
async function requireActiveRun(ctx: QueryCtx | MutationCtx, args: { projectId: Doc<'projects'>['_id']; ownerId: string; runId: string }) {
  const project = await readProject(ctx, args.projectId);
  if (!project || project.deleting || project.ownerId !== args.ownerId || !holdsRun(project, args.runId)) throw new ConvexError('AI run is no longer active');
  return project;
}
export const listRunTimelines = internalQuery({ args: runArgs, handler: async (ctx, args) => {
  if (!args.runId.startsWith(READ_ONLY_RUN_PREFIX)) await requireRunState(ctx, args);
  return listTabsFor(ctx, args.ownerId, args.projectId);
}});
const runTabArgs = { ...runArgs, expectedRevision: v.number() };
async function prepareRunTab(ctx: MutationCtx, args: { projectId: Doc<'projects'>['_id']; ownerId: string; runId: string; expectedRevision: number }) {
  const project = await requireActiveRun(ctx, args);
  if ((project.revision ?? 0) !== args.expectedRevision) throw new ConvexError('The timeline changed elsewhere. Inspect the current timeline before continuing.');
  const preview = await ctx.db.query('aiTimelinePreviews').withIndex('by_project', q => q.eq('projectId', args.projectId)).unique();
  if (preview && (preview.runId !== args.runId || preview.baseRevision !== args.expectedRevision || !equalTimelineValue(await loadSceneCode(ctx, preview.timeline), currentTimeline(project)))) throw new ConvexError('Finish the current timeline draft before opening another timeline.');
  await clearLivePreview(ctx, args.projectId);
  return project;
}
async function openedRunTab(ctx: MutationCtx, args: { projectId: Doc<'projects'>['_id']; ownerId: string; runId: string }) {
  await writeProject(ctx, args.projectId, { aiUndoRecorded: false, aiCheckpointRevision: undefined });
  const plan = await ctx.db.query('assistantPlans').withIndex('by_project', q => q.eq('projectId', args.projectId)).unique();
  if (plan?.runId === args.runId) await ctx.db.delete(plan._id);
  const project = await requireActiveRun(ctx, args);
  return { timelineId: activeTabOf(project), timeline: await loadSceneCode(ctx, currentTimeline(project)), revision: project.revision ?? 0 };
}
export const createRunTimeline = internalMutation({ args: { ...runTabArgs, from: v.union(v.literal('blank'), v.literal('duplicate')), name: v.optional(v.string()), aspectRatio: v.optional(v.union(v.literal('landscape'), v.literal('vertical'), v.literal('square'))) }, handler: async (ctx, args) => {
  await prepareRunTab(ctx, args);
  await createTabFor(ctx, args.ownerId, { projectId: args.projectId, from: args.from, name: args.name, aspectRatio: args.aspectRatio }, args.runId);
  return openedRunTab(ctx, args);
}});
export const openRunTimeline = internalMutation({ args: { ...runTabArgs, timelineId: v.string() }, handler: async (ctx, args) => {
  const project = await prepareRunTab(ctx, args);
  if (activeTabOf(project) === args.timelineId) return { timelineId: args.timelineId, timeline: await loadSceneCode(ctx, currentTimeline(project)), revision: project.revision ?? 0 };
  await openTabFor(ctx, args.ownerId, { projectId: args.projectId, timelineId: args.timelineId }, args.runId);
  return openedRunTab(ctx, args);
}});
export const importRunVideo = internalMutation({ args: { ...runArgs, url: v.string(), start: v.optional(v.number()), end: v.optional(v.number()) }, handler: async (ctx, args) => {
  await requireActiveRun(ctx, args);
  return importVideoFor(ctx, args.ownerId, { projectId: args.projectId, url: args.url, start: args.start, end: args.end, sourcesOnly: true });
}});
export const runMediaTask = internalQuery({ args: { ...runArgs, taskId: v.string() }, handler: async (ctx, args) => {
  await requireRunState(ctx, args);
  const taskId = ctx.db.normalizeId('mediaTasks', args.taskId);
  const view=taskId?await ctx.db.query('mediaTaskViews').withIndex('by_task',q=>q.eq('taskId',taskId)).unique():null;
  const task = view ?? (taskId ? await ctx.db.get(taskId) : null);
  if (!task || task.ownerId !== args.ownerId || task.projectId !== args.projectId) throw new ConvexError('Media task not found.');
  const progress=taskId?await ctx.db.query('mediaTaskProgress').withIndex('by_task',q=>q.eq('taskId',taskId)).unique():null;
  return { taskId, status: task.status, progress:progress?.progress??task.progress, error: task.error, assetId:!view&&'outputAssetId' in task?task.outputAssetId??task.assetId:task.assetId };
}});
export const exportRunVideo = internalMutation({ args: { ...runArgs, timelineId: v.optional(v.string()), resolution: v.number(), fps: v.number(), quality: v.string() }, handler: async (ctx, args) => {
  await requireActiveRun(ctx, args);
  const jobId = await startRenderFor(ctx, args.ownerId, { projectId: args.projectId, timelineId: args.timelineId, resolution: args.resolution, fps: args.fps, quality: args.quality });
  return { jobId };
}});

export const beginEditing = internalMutation({ args: runArgs, returns: v.null(), handler: async (ctx, args) => {
  const project = await projectRun(ctx,args.projectId,args.ownerId);
  if (!project.aiRunning || project.aiRunId !== args.runId) throw new ConvexError('AI run is no longer active');
  if (!project.aiEditing) await writeRunState(ctx,project._id,{aiEditing:true});
  return null;
}});
/** Recheck persisted access at inference time, including turns saved by older clients/runners. */
export const modelForRun = internalQuery({
  args: { ...runArgs, pinnedModel: v.optional(pinnedClaudeModelValidator) },
  returns: pinnedClaudeModelValidator,
  handler: async (ctx, args): Promise<ClaudeModelSelection> => {
    await requireActiveRun(ctx, args);
    await requireRunPlan(ctx, args.ownerId, args.runId);
    if (!await hasPaidModelAccess(ctx, args.ownerId)) return freeEditorModel();
    return validatePinnedClaudeModel(args.pinnedModel ?? resolveClaudeModel());
  },
});
export const isRunActive = internalQuery({ args: runArgs, returns: v.boolean(), handler: (ctx, args) => runIsActive(ctx, args) });
export const getRun = internalQuery({args:runArgs,returns:v.object({project:projectDocument,assets:v.array(assetDocument)}),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(!args.runId.startsWith(READ_ONLY_RUN_PREFIX)&&(run.aiRunId!==args.runId||!run.aiRunning))throw new ConvexError('AI run is no longer active');
  const raw=(await ctx.db.get(args.projectId))!,payload=await runPayload(ctx,args.projectId);
  // Full model context still needs recovery/request text; run-state checks deliberately do not.
  const project={...raw,...(payload?{aiRequest:payload.aiRequest,aiRecovery:payload.aiRecovery}:{})};
  const assets=await ctx.db.query('assets').withIndex('by_ownerId_projectId',q=>q.eq('ownerId',args.ownerId).eq('projectId',args.projectId)).take(PROJECT_MEDIA_LIMIT);
  // A read of a named tab (MCP timelineId) serves that tab's stored timeline without opening it.
  const tab=boundRunTab(args.runId);
  if(tab&&tab!==activeTabOf(project)){const stored=await storedTabTimeline(ctx,project,tab);if(!stored)throw new ConvexError('That timeline no longer exists.');return {project:{...project,...run,activeTimelineId:tab,aspectRatio:stored.aspectRatio,timeline:await loadSceneCode(ctx,stored)},assets};}
  return {project:{...project,...run,timeline:await loadSceneCode(ctx,currentTimeline(project))},assets};
}});
export const getRunTimeline=internalQuery({args:runArgs,returns:v.object({timeline:timelineValidator,revision:v.number()}),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  const project=(await ctx.db.get(args.projectId))!,tab=mcpRunTab(args.runId);
  const timeline=tab?await storedTabTimeline(ctx,project,tab):currentTimeline(project);
  if(!timeline)throw new ConvexError('That timeline no longer exists.');
  return {timeline:await loadSceneCode(ctx,timeline),revision:project.revision??0};
}});
/** The tab a run works on: a read of a named tab, or the open one. */
const runTab=(project:Doc<'projects'>,runId:string)=>boundRunTab(runId)??activeTabOf(project);
/** Diff both saved snapshots in one query, so concurrent edits cannot mix their states. */
export const diffScene=internalQuery({args:{...runArgs,clipId:v.string(),fromRevision:v.number(),toRevision:v.number(),offset:v.optional(v.number()),limit:v.optional(v.number()),context:v.optional(v.number())},returns:v.any(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);
  if(!args.runId.startsWith(READ_ONLY_RUN_PREFIX)&&(run.aiRunId!==args.runId||!run.aiRunning))throw new ConvexError('AI run is no longer active');
  const project=(await ctx.db.get(args.projectId))!,current=project.revision??0,timelineId=runTab(project,args.runId);
  const start=await historyStart(ctx,project._id,current);
  for(const revision of [args.fromRevision,args.toRevision])if(!Number.isInteger(revision)||revision<start||revision>current)throw new ConvexError(`Choose a saved revision from ${start} to ${current}. Call listRevisions for revision numbers.`);
  const timeline=timelineId===activeTabOf(project)?currentTimeline(project):await storedTabTimeline(ctx,project,timelineId);
  if(!timeline)throw new ConvexError('That timeline no longer exists.');
  const at=async(revision:number)=>{
    const change=await clipChangeAfter(ctx,project._id,timelineId,args.clipId,revision);
    const clip=change?change.before:timeline.clips.find(item=>item.id===args.clipId);
    if(!clip)throw new ConvexError(`Clip ${args.clipId} did not exist on this tab at revision ${revision}.`);
    const loaded=(await loadSceneCode(ctx,{clips:[clip]})).clips[0];
    return sceneCodeSource(loaded);
  };
  const [before,after]=await Promise.all([at(args.fromRevision),at(args.toRevision)]);
  return {clipId:args.clipId,timelineId,target:'scene',...sceneCodeDiff(before,after,args.fromRevision,args.toRevision,args)};
}});
/** A fix note belongs to a saved edit, not the brief or the next timeline revision. */
export const recordFix=scopedRunMutation({args:{...runArgs,clipId:v.string(),revision:v.number(),summary:v.string(),verification:v.string()},returns:v.any(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);
  if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  const project=(await ctx.db.get(args.projectId))!,timelineId=runTab(project,args.runId);
  const row=await ctx.db.query('revisionLog').withIndex('by_project_tab_revision',q=>q.eq('projectId',project._id).eq('timelineId',timelineId).eq('revision',args.revision)).first();
  if(!row||!row.clipIds.includes(args.clipId))throw new ConvexError('That saved revision did not change this clip on this tab, or is no longer retained. Read listRevisions with clipId first.');
  const summary=args.summary.trim(),verification=args.verification.trim();
  if(!summary||summary.length>1000||!verification||verification.length>4000)throw new ConvexError('Give what changed (up to 1000 characters) and how it was verified (up to 4000 characters).');
  const fixes=row.fixes??[],existing=fixes.find(fix=>fix.clipId===args.clipId&&fix.summary===summary&&fix.verification===verification);
  if(existing)return {revision:row.revision,timelineId,fix:existing};
  if(fixes.length>=20)throw new ConvexError('This revision already has 20 fix records. Keep further details in the next saved fix.');
  const fix={id:crypto.randomUUID(),clipId:args.clipId,summary,verification,at:Date.now(),by:runAuthorLabel(run.aiRunId,run.aiAgentName)};
  await ctx.db.patch(row._id,{fixes:[...fixes,fix]});
  return {revision:row.revision,timelineId,fix};
}});
/** listRevisions: recent saved edits, newest first, for one tab or clip. Read-only runs may call it. */
export const revisionHistory=internalQuery({args:{...runArgs,timelineId:v.optional(v.string()),clipId:v.optional(v.string()),revision:v.optional(v.number()),limit:v.number()},returns:v.any(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(!args.runId.startsWith(READ_ONLY_RUN_PREFIX)&&(run.aiRunId!==args.runId||!run.aiRunning))throw new ConvexError('AI run is no longer active');
  const project=(await ctx.db.get(args.projectId))!,current=project.revision??0;
  const namedTab=boundRunTab(args.runId);
  const timelineId=args.timelineId??(args.clipId||namedTab?runTab(project,args.runId):undefined);
  const rows=await listRevisions(ctx,project._id,{timelineId,clipId:args.clipId,revision:args.revision,limit:args.limit});
  const tabs=new Map(tabsOf(project).map(tab=>[tab.id,tab.name]));
  return {currentRevision:current,openTimelineId:activeTabOf(project),historyStartsAt:await historyStart(ctx,project._id,current),revisions:rows.map(row=>({revision:row.revision,at:new Date(row.at).toISOString(),timelineId:row.timelineId,timeline:tabs.get(row.timelineId)??'(deleted tab)',by:row.by,...(row.tool?{tool:row.tool}:{}),summary:row.summary,...(row.fixes?.length?{fixes:row.fixes}:{}),clipIds:row.clipIds.slice(0,12),...(row.clipIds.length>12?{moreClips:row.clipIds.length-12}:{})}))};
}});
/** restoreClip/restoreTimeline: each changed clip's state at a revision on the run's tab (one clip, or all). */
export const revisionChanges=internalQuery({args:{...runArgs,revision:v.number(),clipId:v.optional(v.string())},returns:v.any(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  const project=(await ctx.db.get(args.projectId))!,current=project.revision??0,timelineId=runTab(project,args.runId);
  const start=await historyStart(ctx,project._id,current);
  if(!Number.isInteger(args.revision)||args.revision>current)throw new ConvexError(`Revision ${args.revision} does not exist yet; the project is at revision ${current}. Call listRevisions for revision numbers.`);
  if(args.revision<start)throw new ConvexError(start===current?`Revision history starts with this project's next saved edit (it is at revision ${current}), so revision ${args.revision} cannot be restored.`:`Revision history for this project starts at revision ${start}; revision ${args.revision} is older and cannot be restored. Call listRevisions to see what is kept.`);
  if(args.clipId)return {timelineId,currentRevision:current,change:await clipChangeAfter(ctx,project._id,timelineId,args.clipId,args.revision)};
  const changes=await tabChangesAfter(ctx,project._id,timelineId,args.revision);
  if(!changes)throw new ConvexError(`Too many edits since revision ${args.revision} to restore the whole timeline in one call. Restore the clips you need with restoreClip.`);
  return {timelineId,currentRevision:current,changes};
}});
export const getRunAsset=internalQuery({args:{...runArgs,assetId:v.string()},returns:assetDocument,handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  const id=ctx.db.normalizeId('assets',args.assetId),asset=id?await ctx.db.get(id):null;
  if(!asset||asset.ownerId!==args.ownerId||asset.projectId!==args.projectId)throw new ConvexError('Media not found');return transportAsset(ctx,asset);
}});
/** The assistant's addSoundEffect attaches the shared catalog sound to this project before placing it. */
export const attachRunStockAudio=internalMutation({args:{...runArgs,catalogId:v.string()},returns:assetDocument,handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  return transportAsset(ctx,await attachStockAudio(ctx,args.ownerId,args.projectId,args.catalogId));
}});
/** Reserve before each paid audio HTTP request, from either MCP or an editor turn. */
export const reserveAudioRequest=internalMutation({args:runArgs,returns:v.null(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);
  if(!args.runId.startsWith(READ_ONLY_RUN_PREFIX)&&(run.aiRunId!==args.runId||!run.aiRunning))throw new ConvexError('AI run is no longer active');
  await requireEditorAccess(ctx,args.ownerId);
  await consumeAudioRequest(ctx,args.ownerId);
  return null;
}});
/** Once per generated sound effect, before the provider call; its HTTP attempts still reserve audio requests. */
export const reserveSoundGeneration=internalMutation({args:runArgs,returns:v.null(),handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);
  if(!args.runId.startsWith(READ_ONLY_RUN_PREFIX)&&(run.aiRunId!==args.runId||!run.aiRunning))throw new ConvexError('AI run is no longer active');
  await requireEditorAccess(ctx,args.ownerId);
  await consumeFairUse(ctx,args.ownerId,'soundGenerations');
  return null;
}});
/** Register a sound the assistant rendered and uploaded; storage counts like an upload, with no analysis tasks. */
export const saveGeneratedSound=internalMutation({args:{...runArgs,r2Key:v.string(),fileName:v.string(),size:v.number(),duration:v.number(),waveform:waveformValidator,recipe:v.optional(v.string()),beats:v.optional(beatsValidator),transcript:v.optional(transcriptValidator),contentType:v.optional(v.union(v.literal('audio/wav'),v.literal('audio/mpeg')))},returns:assetDocument,handler:async(ctx,args)=>{
  const run=await projectRun(ctx,args.projectId,args.ownerId);if(run.aiRunId!==args.runId||!run.aiRunning)throw new ConvexError('AI run is no longer active');
  if(!args.r2Key.startsWith(projectMediaPrefix(args.ownerId,args.projectId)))throw new ConvexError('Generated sound key is outside this project');
  const count=await ctx.db.query('assets').withIndex('by_ownerId_projectId',q=>q.eq('ownerId',args.ownerId).eq('projectId',args.projectId)).take(PROJECT_MEDIA_LIMIT);
  if(count.length>=PROJECT_MEDIA_LIMIT)throw new ConvexError(`A project supports up to ${PROJECT_MEDIA_LIMIT} media files`);
  validateWaveform(args.waveform);
  const id=await ctx.db.insert('assets',{ownerId:args.ownerId,projectId:args.projectId,kind:'audio',fileName:args.fileName,r2Key:args.r2Key,contentType:args.contentType??'audio/wav',size:args.size,duration:args.duration,waveform:args.waveform,...(args.recipe?{soundRecipe:args.recipe}:{}),createdAt:Date.now()});
  // A music bed knows its beats exactly, and narration its words: they are saved as its analysis, like measured ones.
  const asset=args.beats||args.transcript?await storeAnalysis(ctx,(await ctx.db.get(id))!,{...(args.beats?{beats:args.beats}:{}),...(args.transcript?{transcript:args.transcript}:{})}):(await ctx.db.get(id))!;
  await recordAssetStorage(ctx,asset);
  return transportAsset(ctx,asset);
}});
export const apply = scopedRunMutation({ args: { ...runArgs, expectedRevision: v.number(), timeline: timelineValidator,publication:v.optional(v.object({threadId:v.string(),promptMessageId:v.string()})),stagedPublication:v.optional(v.boolean()),tool:v.optional(v.string()) }, returns: v.number(), handler: async (ctx, args) => {
  const note=args.tool?{tool:args.tool}:undefined;
  const project = await requireProject(ctx, args.projectId, args.ownerId, false);
  if (project.aiRunId !== args.runId || !project.aiRunning) throw new ConvexError("AI run is no longer active");
  if(args.publication&&project.threadId!==args.publication.threadId)throw new ConvexError('Publication conversation does not match this project.');
  // A stale revision is refused below; compare overlaps only against the base this draft was built on.
  if((project.revision??0)===args.expectedRevision)rejectNewLayerOverlaps(currentTimeline(project),args.timeline);
  const receipt=async(revision:number)=>{
    const previous=await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',project._id)).unique();
    // The preview stores scene code by hash like the project; compare and describe in that form.
    const timeline=await storeSceneCode(ctx,normalizeTimeline(args.timeline),storedSceneCode(previous?.timeline));
    const unchanged=previous?.runId===args.runId&&equalTimelineValue(previous.timeline,timeline);
    const change=unchanged?{label:previous.label,changedClipIds:previous.changedClipIds,removedClips:previous.removedClips,at:previous.at}:describeLiveEdit(previous?.runId===args.runId?previous.timeline:(await withoutSceneCode(currentTimeline(project))).timeline,timeline);
    const values={projectId:project._id,ownerId:args.ownerId,runId:args.runId,baseRevision:revision,timeline,...change,sequence:(previous?.runId===args.runId?previous.sequence:0)+(unchanged?0:1),updatedAt:Date.now()};
    if(previous)await ctx.db.replace(previous._id,values);else await ctx.db.insert('aiTimelinePreviews',values);
    if(args.publication)await savePublicationReceipt(ctx,args.ownerId,{version:1,kind:'timeline-publication',status:'saved',...args.publication,runId:args.runId,stagedRevision:args.expectedRevision,revision});
    if (args.stagedPublication) await publishIncidentRun(ctx, args.runId, args.expectedRevision, revision);
    return revision;
  };
  if (project.aiUndoRecorded && project.aiCheckpointRevision === args.expectedRevision) {
    if ((project.revision ?? 0) !== args.expectedRevision) throw new ConvexError(TIMELINE_CONFLICT);
    const timeline = await validateTimeline(ctx, project, args.timeline);
    const revision = args.expectedRevision + 1;
    await writeProject(ctx,project._id, { timeline, aspectRatio: timeline.aspectRatio, revision, aiCheckpointRevision: revision, updatedAt: Date.now() }, undefined, note); return receipt(revision);
  }
  const revision = await commitTimeline(ctx, project, args.timeline, args.expectedRevision, undefined, undefined, undefined, note);
  await writeProject(ctx,project._id, { aiUndoRecorded: true, aiCheckpointRevision: revision }); return receipt(revision);
}});
/** Undo only stored history before this model turn publishes its own checkpoints. */
export const undoLatestEdit=scopedRunMutation({args:{...runArgs,expectedRevision:v.number(),overrideApproved:v.optional(v.boolean())},returns:v.object({undone:v.boolean(),revision:v.number(),timeline:timelineValidator}),handler:async(ctx,args)=>{
  const project=await requireProject(ctx,args.projectId,args.ownerId,true);
  if(project.aiRunId!==args.runId||!project.aiRunning)throw new ConvexError('AI run is no longer active');
  if(project.aiUndoRecorded)throw new ConvexError('Undo the latest saved edit before making changes in this turn.');
  if((project.revision??0)!==args.expectedRevision)throw new ConvexError('The timeline changed elsewhere. Inspect it before undoing.');
  const history=(project.history??[]).map(normalizeTimeline),previous=history.pop();
  if(!previous)return {undone:false,revision:project.revision??0,timeline:currentTimeline(project)};
  // Undo is an edit too: it may not take back approved work, or the approval itself, unless the user asked.
  if(!args.overrideApproved){
    const current=currentTimeline(project),kept=new Map(previous.clips.map(clip=>[clip.id,clip]));
    const unmarked=current.clips.filter(clip=>isApproved(clip)&&!isApproved(kept.get(clip.id)??clip)).map(clip=>({clipId:clip.id,name:clip.scene?.title||clip.kind,what:'remove its approval'}));
    const touched=[...approvalViolations(current,previous),...unmarked];
    if(touched.length)throw new ConvexError(approvalRefusal(touched));
  }
  const timeline=await validateTimeline(ctx,project,previous),revision=args.expectedRevision+1;
  await writeProject(ctx,project._id,{timeline,aspectRatio:timeline.aspectRatio,history,revision,aiEditing:true,aiCheckpointRevision:undefined,updatedAt:Date.now()},undefined,{tool:'undoLatestEdit'});
  return {undone:true,revision,timeline};
}});
// Destructive turns validate each private draft without exposing intermediate deletions.
// The final apply repeats these checks atomically before publishing the replacement.
export const validateDraft = internalQuery({ args: { ...runArgs, expectedRevision: v.number(), timeline: timelineValidator }, returns: v.null(), handler: async (ctx, args) => {
  let project = await requireProject(ctx, args.projectId, args.ownerId);
  const tab=mcpRunTab(args.runId);
  if(tab&&tab!==activeTabOf(project)){
    const timeline=await storedTabTimeline(ctx,project,tab);
    if(!timeline)throw new ConvexError('That timeline no longer exists.');
    project={...project,activeTimelineId:tab,timeline,aspectRatio:timeline.aspectRatio};
  }
  if (project.aiRunId !== args.runId || !project.aiRunning) throw new ConvexError('AI run is no longer active');
  if ((project.revision ?? 0) !== args.expectedRevision) throw new ConvexError('The timeline changed elsewhere. Your replacement was not saved.');
  await validateTimeline(ctx, project, args.timeline);
  rejectNewLayerOverlaps(currentTimeline(project), args.timeline);
  return null;
}});
/** A read-only client projection. This never publishes a draft or adds undo history. */
export const previewDraft = scopedRunMutation({args:{...runArgs,expectedRevision:v.number(),timeline:timelineValidator},returns:v.null(),handler:async(ctx,args)=>{
  const project=await requireProject(ctx,args.projectId,args.ownerId);
  if(!project.aiRunning||project.aiRunId!==args.runId)throw new ConvexError('AI run is no longer active');
  if((project.revision??0)!==args.expectedRevision)throw new ConvexError('The timeline changed elsewhere. Your replacement was not saved.');
  const timeline=await validateTimeline(ctx,project,args.timeline);
  rejectNewLayerOverlaps(currentTimeline(project),timeline);
  const previous=await ctx.db.query('aiTimelinePreviews').withIndex('by_project',q=>q.eq('projectId',project._id)).unique();
  const current=previous?.runId===args.runId&&previous.baseRevision===args.expectedRevision?previous:null;
  const stored=await storeSceneCode(ctx,timeline,storedSceneCode(previous?.timeline));
  if(current&&equalTimelineValue(current.timeline,stored))return null;
  const values={projectId:project._id,ownerId:args.ownerId,runId:args.runId,baseRevision:args.expectedRevision,timeline:stored,...describeLiveEdit(current?.timeline??(await withoutSceneCode(currentTimeline(project))).timeline,stored),sequence:(current?.sequence??0)+1,updatedAt:Date.now()};
  if(previous)await ctx.db.replace(previous._id,values);else await ctx.db.insert('aiTimelinePreviews',values);
  return null;
}});
const aiFieldsForFinish=(payload:Awaited<ReturnType<typeof runPayload>>)=>({aiRequest:payload?.aiRequest,aiRecovery:payload?.aiRecovery});
export const finish = internalMutation({ args: { ...runArgs, error: v.optional(v.string()), savedEdits:v.optional(v.number()),publication:v.optional(v.object({threadId:v.string(),promptMessageId:v.string(),stagedRevision:v.number(),status:v.union(v.literal('failed'),v.literal('aborted'))})),segment:v.optional(v.number()) }, returns: v.null(), handler: async (ctx, args) => {
  const timeout=await ctx.db.query('mcpRunTimeouts').withIndex('by_run',q=>q.eq('runId',args.runId)).unique();
  if(timeout?.ownerId===args.ownerId&&timeout.projectId===args.projectId){
    const scheduled=await ctx.db.system.get(timeout.scheduledId);
    if(scheduled?.state.kind==='pending')await ctx.scheduler.cancel(timeout.scheduledId);
    await ctx.db.delete(timeout._id);
  }
  const turn=await turnSummaryForRun(ctx,args.runId);
  if(turn&&args.segment!==undefined&&turn.segment!==args.segment)return null;
  const state = await projectRunContext(ctx,args.projectId,args.ownerId).catch(()=>null);
  // The delayed MCP timeout still fires after a successful call; stale timers need no cleanup reads.
  if(!args.publication&&turn?.status!=='running'&&(!state?.aiRunning||state.aiRunId!==args.runId))return null;
  const payload=state?await runPayload(ctx,args.projectId):null;
  const project=state?{...state,...(payload?aiFieldsForFinish(payload):{})}:null;
  // A stopped action may finish after a new run starts. Its receipt belongs to
  // the original prompt; it must never stop or overwrite the newer run.
  const publication = args.publication && project?.ownerId === args.ownerId && project.threadId === args.publication.threadId ? args.publication : undefined;
  const written = publication ? await ctx.db.query('toolWriteReceipts').withIndex('by_run_stage', q => q.eq('runId', args.runId).eq('stagedRevision', publication.stagedRevision)).first() : null;
  const committed = written?.ownerId === args.ownerId && written.projectId === args.projectId && written.receipt?.kind === 'timeline' && written.receipt.status === 'saved' && written.receipt.revision === (publication?.stagedRevision ?? -1) + 1;
  if(publication&&!committed)await savePublicationReceipt(ctx,args.ownerId,{version:1,kind:'timeline-publication',runId:args.runId,...publication});
  if(turn&&turn.status==='running')await settleTurn(ctx,turn,{status:args.error&&!committed?'failed':'completed',error:committed?undefined:args.error?.slice(0,1000)});
  await finishIncidentRun(ctx, args.runId, committed && publication && written?.receipt ? { status: 'saved', stagedRevision: publication.stagedRevision, revision: written.receipt.revision } : publication);
  const error = committed ? undefined : args.error;
  if (error && project?.ownerId === args.ownerId && project.aiRunId === args.runId) await recordIncident(ctx, {
    source: 'assistant', kind: 'turn-failure', message: error,
    context: { location: 'convex/assistant:finish', savedEdits: args.savedEdits },
    projectId: args.projectId, runId: args.runId, deployment: incidentDeployment(),
  });
  if (project?.ownerId === args.ownerId && project.aiRunId === args.runId) {
    await clearLivePreview(ctx,project._id);
    const requests = await ctx.db.query("analysisRequests").withIndex("by_projectId_runId", q => q.eq("projectId", args.projectId).eq("aiRunId", args.runId)).take(16);
    for (const request of requests) await detachAnalysisRequest(ctx,request);
    // A recovery may finish with verification alone. Use persisted review
    // receipts, not the assistant's prose, to retire the unfinished status.
    const reviews=!error&&project.aiRecovery&&!project.aiUndoRecorded?(await ctx.db.query('compositionReviews').withIndex('by_project',q=>q.eq('projectId',project._id)).order('desc').take(8)).filter(review=>review.ownerId===project.ownerId&&review.runId===args.runId&&review.revision===(project.revision??0)&&review.status==='completed'):[];
    const recoveryChecked=reviews.length>0&&reviews.every(review=>review.result?.revision===(project.revision??0)&&review.result.observations.length>0&&review.result.observations.every(observation=>observation.verdict==='pass')&&review.result.checks.every(check=>check.timingPass&&check.pixelPass!==false&&check.returnPass!==false&&check.textSafe!==false));
    await writeRunState(ctx,project._id, { aiRunning: false, aiEditing: false, aiReturnTimelineId: undefined, aiError: error?.slice(0, 1000), aiRecovery:error?assistantRecovery(project,'failed',error,args.savedEdits):project.aiUndoRecorded||recoveryChecked?undefined:project.aiRecovery,aiRequest:undefined,aiAnalysisUsage:settledAnalysisUsage(project.aiAnalysisUsage) });
    // An MCP call that borrowed another tab hands the user's tab back.
    const returnTo=project.aiReturnTimelineId;
    if(returnTo&&returnTo!==activeTabOf(project)&&tabsOf(project).some(tab=>tab.id===returnTo))await openTabFor(ctx,project.ownerId,{projectId:project._id,timelineId:returnTo});
    if(!project.aiQueuePaused)await ctx.scheduler.runAfter(0,internal.assistant.drainQueue,{projectId:project._id,ownerId:project.ownerId});
  }
  if(project?.threadId)await ctx.scheduler.runAfter(10_000,internal.assistantMessages.settleThread,{threadId:project.threadId,cursor:null});
  return null;
}});

export const requestAnalysis = internalMutation({ args: { ...runArgs, assetId: v.string(), mode: analysisMode, highlightSkipGemini:v.optional(v.string()),highlightSourceType:v.optional(highlightSourceTypeValidator), speakerRequest:v.optional(speakerRequestValidator), frameRequest: v.optional(frameRequestValidator), videoRequest: v.optional(videoRequestValidator) }, returns: v.id("analysisRequests"), handler: async (ctx, args) => {
  if (args.mode === 'understand') throw new ConvexError('Optional footage overviews start after the editor opens.');
  const project = await requireProject(ctx, args.projectId, args.ownerId);
  if (!project.aiRunning || project.aiRunId !== args.runId) throw new ConvexError("AI run is no longer active");
  const assetId = ctx.db.normalizeId("assets", args.assetId); const asset = assetId ? await ctx.db.get(assetId) : null;
  if (!asset || asset.ownerId !== args.ownerId || asset.projectId !== args.projectId || asset.kind === "image" || ((args.mode === 'highlights' || args.mode === 'reference' || args.mode === "shots" || args.mode === "track" || args.mode === "facecam" || args.mode === "speakers" || args.mode === 'frames' || args.mode === 'video') && asset.kind !== "video")) throw new ConvexError("Choose suitable media from this project");
  if(args.mode==='speakers'){
    const range=args.speakerRequest??{start:0,end:asset.duration??0};
    if(!Number.isFinite(range.start)||!Number.isFinite(range.end)||range.start<0||range.end<=range.start||range.end>(asset.duration??0)+.01||range.end-range.start>MAX_SPEAKER_WINDOW_SECONDS)throw new ConvexError(`Analyze active speakers in a source window of up to ${MAX_SPEAKER_WINDOW_SECONDS} seconds. Use followSubject on a retained clip.`);
  }else if(args.speakerRequest)throw new ConvexError('Speaker windows require speaker analysis.');
  if (args.mode === 'frames') {
    if (!args.frameRequest || !asset.duration) throw new ConvexError('Choose a video window and a focused visual question.');
    try { validateFrameInspectionInput(args.frameRequest, asset.duration); } catch (error) { throw new ConvexError((error as Error).message); }
  } else if (args.frameRequest) throw new ConvexError('Frame questions require a frame inspection.');
  if (args.mode === 'video') {
    if (!args.videoRequest || !asset.duration) throw new ConvexError('Choose a video source window and a question.');
    try { validateVideoInspectionInput(args.videoRequest, asset.duration); } catch (error) { throw new ConvexError((error as Error).message); }
  } else if (args.videoRequest) throw new ConvexError('Video questions require a native video inspection.');
  const requests = await ctx.db.query("analysisRequests").withIndex("by_projectId_runId", q => q.eq("projectId", project._id).eq("aiRunId", args.runId)).take(16);
  if(!project.aiEditing)await writeProject(ctx,project._id,{aiEditing:true});
  const requested = args.mode === 'video' ? args.videoRequest : args.mode === 'frames' ? args.frameRequest : undefined;
  if(requested){
    const repeated=requests.find(request=>{
      const inspection = args.mode === 'video' ? request.videoRequest : request.frameRequest;
      return request.assetId===asset._id&&request.mode===args.mode&&request.status!=='failed'&&inspection?.question===requested.question&&inspection.start===requested.start&&inspection.end===requested.end;
    });
    if(repeated)return repeated._id;
  }
  const requestId = await ctx.db.insert("analysisRequests", { ownerId: args.ownerId, projectId: project._id, assetId: asset._id, aiRunId: args.runId, mode: args.mode, ...(args.highlightSkipGemini?{highlightSkipGemini:args.highlightSkipGemini}:{}),...(args.highlightSourceType?{highlightSourceType:args.highlightSourceType}:{}),...(args.speakerRequest?{speakerRequest:args.speakerRequest}:{}), ...(args.frameRequest ? { frameRequest: args.frameRequest } : {}), ...(args.videoRequest ? { videoRequest: args.videoRequest } : {}), status: "pending", createdAt: Date.now(), expiresAt: Date.now() + (args.mode === 'highlights' ? 840_000 : args.mode === 'reference' ? 480_000 : 240_000) });
  const taskId = await enqueueMediaTask(ctx, { ownerId: args.ownerId, projectId: project._id, assetId: asset._id, kind: args.mode, analysisRequestId: requestId, ...(args.highlightSkipGemini?{highlightSkipGemini:args.highlightSkipGemini}:{}),...(args.highlightSourceType?{highlightSourceType:args.highlightSourceType}:{}),...(args.speakerRequest?{speakerRequest:args.speakerRequest}:{}), ...(args.frameRequest ? { frameRequest: args.frameRequest } : {}), ...(args.videoRequest ? { videoRequest: args.videoRequest } : {}) },async()=>{
    // Rows are deleted when callers finish, but the original run's capacity
    // must survive that cleanup and every durable continuation segment.
    const enqueued=project.aiAnalysisUsage?.runId===args.runId?project.aiAnalysisUsage.enqueued:requests.length;
    if(enqueued>=15)throw new ConvexError('Too many analysis requests in one AI run');
    // An accepted run may analyse beside upload preparation, up to the ceiling.
    await requireMediaTaskCapacity(ctx,args.ownerId,1,{ceiling:2});
    await writeProject(ctx,project._id,{aiAnalysisUsage:{...(project.aiAnalysisUsage?.runId===args.runId?project.aiAnalysisUsage:{}),runId:args.runId,enqueued:enqueued+1}});
  });
  await ctx.db.patch(requestId, { taskId });
  return requestId;
}});
export const analysisRequest = internalQuery({ args: { ...runArgs, requestId: v.id("analysisRequests") }, returns: analysisRequestDocument, handler: async (ctx, args) => {
  const project = await projectRun(ctx,args.projectId,args.ownerId); const request = await ctx.db.get(args.requestId);
  if (!project.aiRunning || project.aiRunId !== args.runId || !request || request.ownerId !== args.ownerId || request.projectId !== project._id || request.aiRunId !== args.runId) throw new ConvexError("AI analysis request is no longer active");
  return request;
}});
/** Remote tool batches and durable continuations share the same optional-provider failure. */
export const videoUnavailable = internalQuery({ args: runArgs, returns: v.union(v.string(), v.null()), handler: async (ctx, args) => {
  const project = await requireRunState(ctx, args);
  return project.aiAnalysisUsage?.runId === args.runId ? project.aiAnalysisUsage.videoUnavailable ?? null : null;
}});
export const recordVideoUnavailable = internalMutation({ args: { ...runArgs, reason: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const project = await requireRunState(ctx, args);
  await persistVideoUnavailable(ctx,project,args.runId,args.reason);
  return null;
}});
export const clearAnalysis = internalMutation({ args: { ...runArgs, requestId: v.id("analysisRequests") }, returns: v.null(), handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (request?.ownerId === args.ownerId && request.projectId === args.projectId && request.aiRunId === args.runId) {
    const project=await projectRun(ctx,args.projectId,args.ownerId);
    if(project.aiRunning&&project.aiRunId===args.runId&&!project.aiEditing)await writeProject(ctx,args.projectId,{aiEditing:true});
    await detachAnalysisRequest(ctx,request);
  }
  return null;
}});

/** The current saved user message, never an older conversational timestamp. */
export const currentPrompt = internalQuery({
  args: { ...runArgs, threadId: v.string(), promptMessageId: v.string() }, returns: v.string(),
  handler: async (ctx, args) => {
    const project = await requireProject(ctx, args.projectId, args.ownerId);
    if (!project.aiRunning || project.aiRunId !== args.runId || project.threadId !== args.threadId) throw new ConvexError('AI run is no longer active');
    const [prompt] = await ctx.runQuery(components.agent.messages.getMessagesByIds, { messageIds: [args.promptMessageId] });
    if (!prompt || prompt.threadId !== args.threadId || prompt.message?.role !== 'user') throw new ConvexError('The current editing prompt is unavailable');
    const content = prompt.message.content;
    return typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join('\n');
  },
});


export const queued=query({args:{projectId:v.id('projects')},returns:v.object({paused:v.boolean(),messages:v.array(v.object({id:v.id('assistantQueue'),prompt:v.string(),error:v.optional(v.string())}))}),handler:async(ctx,{projectId})=>{
  const project=await projectRun(ctx,projectId,await requireOwner(ctx));
  const rows=await ctx.db.query('assistantQueue').withIndex('by_project',q=>q.eq('projectId',projectId)).take(10);
  return {paused:!!project.aiQueuePaused,messages:rows.map(row=>({id:row._id,prompt:row.prompt,...(row.error?{error:row.error}:{})}))};
}});
export const removeQueued=mutation({args:{projectId:v.id('projects'),id:v.id('assistantQueue')},returns:v.null(),handler:async(ctx,args)=>{
  const ownerId=await requireOwner(ctx);await requireProject(ctx,args.projectId,ownerId);
  const row=await ctx.db.get(args.id);
  if(!row)return null;
  if(row.ownerId!==ownerId||row.projectId!==args.projectId)throw new ConvexError('Queued message not found.');
  await ctx.db.delete(row._id);return null;
}});
export const resumeQueue=mutation({args:{projectId:v.id('projects')},returns:v.null(),handler:async(ctx,{projectId})=>{
  const ownerId=await requireOwner(ctx);await requireProject(ctx,projectId,ownerId);await requireInAppAgentAccess(ctx,ownerId);
  await writeProject(ctx,projectId,{aiQueuePaused:false});
  await ctx.scheduler.runAfter(0,internal.assistant.drainQueue,{projectId,ownerId});return null;
}});
export const drainQueue=internalMutation({args:{projectId:v.id('projects'),ownerId:v.string()},returns:v.null(),handler:async(ctx,args)=>{
  const raw=await ctx.db.get(args.projectId);
  if(!raw||raw.deleting||raw.ownerId!==args.ownerId)return null;
  const run=await projectRun(ctx,args.projectId,args.ownerId);
  if(run.aiRunning||run.aiQueuePaused)return null;
  const row=await ctx.db.query('assistantQueue').withIndex('by_project',q=>q.eq('projectId',args.projectId)).first();
  if(!row)return null;
  try{
    await ctx.runMutation(internal.assistant.startQueued,{...args,id:row._id});
  }catch{
    await ctx.db.patch(row._id,{error:'This queued request could not start. Check your access and attached footage, then resume the queue.'});
    await writeProject(ctx,args.projectId,{aiQueuePaused:true});
  }
  return null;
}});


/** Nested mutation makes starting and removing the head one atomic operation. */
export const startQueued=internalMutation({args:{projectId:v.id('projects'),ownerId:v.string(),id:v.id('assistantQueue')},returns:v.null(),handler:async(ctx,args)=>{
  const project=await requireProject(ctx,args.projectId,args.ownerId);
  if(project.aiRunning||project.aiQueuePaused)return null;
  const row=await ctx.db.query('assistantQueue').withIndex('by_project',q=>q.eq('projectId',args.projectId)).first();
  if(!row||row._id!==args.id||row.ownerId!==args.ownerId)return null;
    await requireInAppAgentAccess(ctx,args.ownerId);
    // A queued choice the plan no longer allows (Opus in-app on Pro) falls back to the default.
    const paidModelAccess=await hasPaidModelAccess(ctx,args.ownerId);
    const queued=paidModelAccess?validatePinnedClaudeModel(row.pinnedModel):freeEditorModel();
    const chosen=queued.modelChoice!==undefined||queued.reasoningEffort!==undefined||queued.speedMode!==undefined;
    const pinnedModel=!paidModelAccess?queued:row.clientPlatform==='ios'?mobileModel():chosen&&!canChooseEditorModel(queued.modelChoice)?enforceClaudeModelPolicy(resolveClaudeModel()):queued;assertEditorModelConfigured(pinnedModel);
    enforceClaudeModelPolicy(pinnedModel);
    for(const id of row.attachedAssetIds??[]){const asset=await ctx.db.get(id);if(!asset||asset.projectId!==project._id||asset.ownerId!==args.ownerId)throw new ConvexError('Attached footage is no longer available. Remove this queued message and send an updated request.');}
    const ids=new Set((await requestTimeline(ctx,project,row.timelineId).catch(()=>currentTimeline(project))).clips.map(clip=>clip.id));
    const selectedClipIds=row.selectedClipIds?.filter(id=>ids.has(id));
    await beginRequest(ctx,project,row.prompt,pinnedModel,{...row,selectedClipId:row.selectedClipId&&ids.has(row.selectedClipId)?row.selectedClipId:undefined,selectedClipIds});
    await ctx.db.delete(row._id);
  return null;
}});
