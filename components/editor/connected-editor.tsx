'use client';
import { reportClientIncident } from '@/lib/incident-client';
import { userError } from '@/lib/user-error';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { NEW_WORKSPACE_LABEL } from '@/lib/editor/workspace-labels';
import { startTransition, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from 'zustand';
import { createEditorStore } from '@/lib/editor/store';
import { createTimelineSaveQueue } from '@/lib/editor/timeline-sync';
import { EditorStateProvider } from './editor-state';
import { useSceneCode } from './use-scene-code';
import { useConvex, useConvexAuth, useMutation, useQueries, useQuery, useAction } from 'convex/react';
import { useClipSceneThumbs, useSceneThumbs } from '@/lib/editor/scene-thumbs-query';
import { aggregateFootageProgress, preparedFootageProgress, transferProgress } from '@/lib/editor/footage-progress';
import { beginFootageOpening, rememberFootageProgress } from '@/lib/editor/footage-progress-store';
import { openingFootage } from '@/lib/editor/footage-opening';
import { clearOpeningBrief, clearOpeningRequestOptions, editorDraftKey, openingBrief, openingRequestOptions } from '@/lib/editor/opening-request';
import { EDITOR_MODELS, EDITOR_REASONING_EFFORTS } from '@/lib/ai/claude-model';
import { WorkspaceNav } from '@/components/workspace/workspace-nav';
import { FootagePreparation } from './footage-preparation';
import { api } from '@/convex/_generated/api';
import type { Id, Doc } from '@/convex/_generated/dataModel';
import { EditorShell } from './editor-shell';
import type { FilmDraftView } from '@/lib/editor/film-draft-view';
import { ConnectedTimelineShareDialog } from './timeline-share-dialog';
import { EditorAccessGate } from '@/components/workspace/editor-access-gate';
import { ProUpgradeCard } from '@/components/workspace/pro-upgrade-card';
import { acknowledgeDraftFiles, takeFiles } from '@/lib/editor/project-draft';
import type { ChatMessage } from './chat-types';
import { matchesUndoSnapshot, type AssistantEditSnapshot } from './assistant-results';
import type { ExportSettings } from './export-dialog';
import { EMPTY_TIMELINE, normalizeTimeline, timelineDuration, type Timeline, type MediaAsset } from '@/lib/editor/types';
import { timelineCover } from '@/lib/editor/timeline-cover';
import { addMediaClip, separateVideoClips } from '@/lib/editor/operations';
import { prepareVideoAudio, prepareAudioWaveform } from '@/lib/editor/prepare-video-audio';
import { prepareMediaForEditing } from '@/lib/editor/prepare-media-for-editing';
import { mediaTaskActivityLabel } from '@/lib/media-analysis/activity';
import { createPlaybackOpeningGate } from '@/lib/editor/editor-opening';
import { isCasualChat } from '@/lib/editor/chat-request';
import { uploadSourceFile } from '@/lib/editor/upload-source';
import { useSourceUpload } from './use-source-upload';
import { composerMedia } from '@/lib/editor/composer-media';
import type { UploadProgress } from './footage-panel';
const EMPTY_MESSAGES:ChatMessage[]=[];
function editorLoading(projectId: string) {
  const hint = openingFootage(projectId);
  return <div className="editor-app footage-preparation-boot"><WorkspaceNav title={NEW_WORKSPACE_LABEL}/><FootagePreparation progressKey={`project:${projectId}`} thumbnail={hint?.thumbnail} fileName={hint?.fileName}/></div>;
}
export function ConnectedEditor({projectId}: {projectId:string}) {
  useState(() => { beginFootageOpening(projectId); return projectId; });
  const {isAuthenticated}=useConvexAuth();
  const project=useQuery(api.projects.get,isAuthenticated?{projectId,includeHistory:false,sceneCode:'refs'}:'skip');
  if(project===null)return <div className="editor-boot"><h1>This project is no longer available.</h1><p>It may have been deleted. You can open another project from your library.</p><Button asChild variant="outline"><Link href="/chats">Your projects</Link></Button></div>;
  if(!project)return editorLoading(projectId);
  return <LoadedEditor key={projectId} projectId={projectId} project={project}/>;
}
function LoadedEditor({projectId,project}:{projectId:string;project:Doc<'projects'>}) {
  // Undo history is up to 10 full timelines. Subscribe to its small index and read each stored snapshot once:
  // snapshots never change, so their queries stay cached while they remain in history.
  const historyIds=useQuery(api.projects.historyIndex,{projectId});
  const snapshots=useQueries(useMemo(()=>Object.fromEntries((historyIds??[]).map(id=>[id,{query:api.projects.historySnapshot,args:{projectId,id,sceneCode:'refs'}}])),[historyIds,projectId]));
  const complete=historyIds!==undefined&&historyIds.every(id=>snapshots[id]!==undefined);
  const stored=useMemo(()=>historyIds&&complete?historyIds.flatMap(id=>{const timeline=snapshots[id];return timeline&&!(timeline instanceof Error)?[timeline as Timeline]:[];}):null,[historyIds,complete]);// eslint-disable-line react-hooks/exhaustive-deps
  // Scene code arrives by hash and is loaded once per code; it never changes, so edits do not re-read it.
  const restore=useSceneCode(projectId,[project?.timeline,...stored??[]]);
  // The project and its index change together; a new revision shows once its new snapshot and code have loaded.
  const loaded=useMemo(()=>project&&stored&&restore?{...project,...(project.timeline?{timeline:restore(project.timeline)}:{}),history:stored.map(restore)}:null,[project,stored,restore]);
  const [shown,setShown]=useState<Doc<'projects'>|null>(null);
  if(loaded&&loaded!==shown)setShown(loaded);
  const current=loaded??(shown?._id===projectId?shown:null);
  if(!current)return editorLoading(projectId);
  return <EditorAccessGate loading={editorLoading(projectId)}><ProjectEditor key={projectId} project={current} storedTimeline={project?._id===current._id?project.timeline:undefined}/></EditorAccessGate>;
}
function ProjectEditor({project,storedTimeline}: {project:Doc<'projects'>;storedTimeline?:Timeline}) {
  // Real frames for motion clips on the timeline, rendered in the background after each saved change.
  const {thumbs:sceneThumbs,rendering:sceneRendering,missing}=useClipSceneThumbs(project._id,storedTimeline);
  const ensureSceneThumbs=useMutation(api.sceneThumbs.ensure);
  // Ask only for clips with no current frames and no render under way; two start at a time, and requests are
  // skipped while the render queue is busy, so keep asking every 20 s until each has frames.
  const missingKey=missing.join(',');
  useEffect(()=>{if(!missingKey)return;const ask=()=>{void ensureSceneThumbs({projectId:project._id,clipIds:missingKey.split(',')}).catch(()=>{});};const timer=setTimeout(ask,2500);const retry=setInterval(ask,20_000);return()=>{clearTimeout(timer);clearInterval(retry);};},[missingKey,project._id,ensureSceneThumbs]);
  const [shareOpen,setShareOpen]=useState(false);
  const projectId=project._id;const convex=useConvex();const media=useQuery(api.assets.list,{projectId,limit:200});const planStatus=useQuery(api.billing.status,{}),plan=planStatus?.plan;const ai=useQuery(api.assistant.status,{projectId});
  const storedPreview=useQuery(api.assistant.livePreview,ai?.running?{projectId,sceneCode:'refs'}:'skip');
  const restorePreview=useSceneCode(projectId,[storedPreview?.timeline,storedPreview&&{clips:storedPreview.removedClips}]);
  const livePreview=useMemo(()=>storedPreview&&restorePreview?{...storedPreview,timeline:restorePreview(storedPreview.timeline),removedClips:restorePreview({clips:storedPreview.removedClips}).clips}:storedPreview===null?null:undefined,[storedPreview,restorePreview]);
  // The film the in-app agent is still writing (addFilm/patchScene streaming), from its own small row.
  const storedFilmDraft=useQuery(api.filmDrafts.forProject,ai?.running?{projectId}:'skip');
  const activePreview=ai?.running&&livePreview?.runId===project.aiRunId&&livePreview?.baseRevision===(project.revision??0)?livePreview:null;
  const save=useMutation(api.projects.saveTimeline);const update=useMutation(api.projects.update);const send=useMutation(api.assistant.send);const retryTurn=useMutation(api.assistant.retry);const stop=useMutation(api.assistant.stop);const renderStart=useMutation(api.renders.start);const renderCancel=useMutation(api.renders.cancel);const downloadExport=useAction(api.renders.download);
  const importVideo=useMutation(api.mediaTasks.importVideo);
  const removeAsset=useMutation(api.assets.remove);
  const registerStockAudio=useMutation(api.assets.registerStockAudio);
  const sourceUpload=useSourceUpload();const saveProjectThumbnail=sourceUpload.saveThumbnail;
  const saveThumbnail=useCallback((assetId:Id<'assets'>,image:Blob)=>saveProjectThumbnail(projectId,assetId,image),[saveProjectThumbnail,projectId]);
  const capturedThumbnails=useRef(new Set<string>());
  const persistThumbnail=useCallback((assetId:string,url:string)=>{
    if(capturedThumbnails.current.has(assetId))return;capturedThumbnails.current.add(assetId);
    void fetch(url).then(response=>response.blob()).then(image=>saveThumbnail(assetId as Id<'assets'>,image)).catch(()=>capturedThumbnails.current.delete(assetId));
  },[saveThumbnail]);
  const refreshMedia=useAction(api.playback.refresh);
  const preparePlayback=useMutation(api.playback.prepare);
  const handleRefreshMedia=useCallback((assetIds:string[])=>refreshMedia({projectId,assetIds:assetIds as Id<'assets'>[]}),[refreshMedia,projectId]);
  const taskHistory=useQuery(api.mediaTasks.list,{projectId,includeProgress:false});
  const taskProgress=useQuery(api.mediaTasks.progressForProject,{projectId});
  const mediaTasks=useMemo(()=>taskHistory?.map(task=>({...task,progress:taskProgress?.find(row=>row.taskId===task._id)?.progress??task.progress})),[taskHistory,taskProgress]);
  const startOverview=useMutation(api.mediaTasks.startOverview);
  const requestedOverviews=useRef(new Set<string>());
  // The app the user connected over MCP most recently (null: none yet, undefined: loading), for the timeline's MCP pill.
  const connector=useQuery(api.mcpAuth.connector,{});
  const mcpConnection=connector&&(connector.connections.reduce<{label:string;at:number}|null>((latest,item)=>{const at=item.lastUsedAt??item.createdAt;return !latest||at>latest.at?{label:item.label,at}:latest;},null)?.label??null);
  const jobs=useQuery(api.renders.list,{projectId,limit:10});
  const rawTimelineTabs=useQuery(api.timelineTabs.list,{projectId});
  const timelineTabs=rawTimelineTabs?.map(tab=>({...tab,agents:ai?.externalAgents?.filter(agent=>agent.timelineId===tab.id)??[]}));
  // An MCP agent stays "working" across its whole request; the server sets how long it counts as active.
  const agent=ai?.externalAgent??null;
  const [agentClock,setAgentClock]=useState(()=>Date.now());
  useEffect(()=>{if(!agent||agent.running)return;const wait=agent.until-Date.now();if(wait<=0)return;const timer=setTimeout(()=>setAgentClock(Date.now()),wait+50);return()=>clearTimeout(timer);},[agent]);
  useEffect(()=>{setAgentClock(Date.now());},[agent?.until,agent?.running]);
  const externalAgent=agent&&(agent.running||agent.until>agentClock)?agent.name.replace(/\s*\([^)]*\)\s*$/,'')||agent.name:null;
  const tabSnapshots=useQuery(api.timelineTabs.snapshots,{projectId,sceneCode:'refs'});
  // A clicked tab shows at once from its snapshot; editing waits until the server has switched.
  const [pendingTab,setPendingTab]=useState<{id:string;timeline:Timeline}|null>(null);
  // While an AI edits the open tab, another tab can be watched read-only; it opens for real when the edit ends.
  const [viewTab,setViewTab]=useState<string|null>(null);
  const aiBusy=!!externalAgent||!!ai?.running,aiBusyRef=useRef(aiBusy);aiBusyRef.current=aiBusy;
  // While an MCP call borrows another tab, the editor keeps showing the user's tab, read-only, until it is handed back.
  const borrowedFrom=project.aiReturnTimelineId&&project.aiReturnTimelineId!==project.activeTimelineId?project.aiReturnTimelineId:null;
  const watchedTab=viewTab??borrowedFrom;
  const viewedSnapshot=watchedTab?tabSnapshots?.find(item=>item.id===watchedTab)?.timeline:undefined;
  const restoreTab=useSceneCode(projectId,[viewedSnapshot,pendingTab?.timeline]);
  const viewedTimeline=useMemo(()=>viewedSnapshot&&restoreTab?normalizeTimeline(restoreTab(viewedSnapshot)):undefined,[viewedSnapshot,restoreTab]);
  const pendingTimeline=useMemo(()=>pendingTab&&restoreTab?normalizeTimeline(restoreTab(pendingTab.timeline)):undefined,[pendingTab,restoreTab]);
  const openTab=useMutation(api.timelineTabs.open),createTab=useMutation(api.timelineTabs.create),renameTab=useMutation(api.timelineTabs.rename),removeTab=useMutation(api.timelineTabs.remove);const [jobId,setJobId]=useState<Id<'renderJobs'>|null>(null);const job=useQuery(api.renders.get,jobId?{jobId}:'skip');
  const [store]=useState(()=>createEditorStore(project.timeline??{...EMPTY_TIMELINE,aspectRatio:project.aspectRatio},project.history??[]));const timeline=useStore(store,s=>s.timeline);const history=useStore(store,s=>s.history);const future=useStore(store,s=>s.future);const timelineRef=useRef(timeline);const [saving,setSaving]=useState(false);const [saveFailed,setSaveFailed]=useState(false);const [error,setError]=useState('');const [title,setTitle]=useState(project.title);
  useEffect(()=>{if(error)reportClientIncident({source:'editor',kind:'user-failure',message:error,projectId,context:{location:'components/editor/connected-editor:error'}});},[error,projectId]);
  useEffect(()=>{setTitle(project.title);},[project.title]);
  const [saves]=useState(()=>createTimelineSaveQueue({timeline,revision:project.revision??0,history:project.history??[]},{
    save: edit=>save({projectId,...edit}),
    load: async()=>{const fresh=await convex.query(api.projects.get,{projectId});if(!fresh)throw new Error('This project is no longer available.');return {timeline:fresh.timeline??{...EMPTY_TIMELINE,aspectRatio:fresh.aspectRatio},revision:fresh.revision??0,history:fresh.history??[]};},
    update: (next,kind,history)=>{timelineRef.current=next;store.getState().replace(next,kind==='remote'?history??true:false);},
    saving:setSaving,failed:setSaveFailed,
    error:(e,rejected)=>setError(rejected?`This edit couldn’t be saved and was undone. ${userError(e,'')}`.trim():userError(e, 'Could not save this edit.')),
  }));
  useEffect(()=>{
    // Unsaved edits retry with backoff; reconnecting retries at once.
    const retry=()=>saves.retry(),warn=(event:BeforeUnloadEvent)=>{if(!saves.busy&&!uploading.current)return;event.preventDefault();event.returnValue='';};
    window.addEventListener('online',retry);window.addEventListener('beforeunload',warn);
    return()=>{window.removeEventListener('online',retry);window.removeEventListener('beforeunload',warn);};
  },[saves]);
  const [composerAssetIds,setComposerAssetIds]=useState<string[]>([]);
  const [composerImportIds,setComposerImportIds]=useState<string[]>([]);
  useEffect(()=>{
    const completed=(mediaTasks??[]).filter(task=>composerImportIds.includes(task._id)&&task.status==='completed'&&task.assetId);
    if(!completed.length)return;
    setComposerAssetIds(previous=>[...new Set([...previous,...completed.map(task=>task.assetId!)])]);
    setComposerImportIds(previous=>previous.filter(id=>!completed.some(task=>task._id===id)));
  },[mediaTasks,composerImportIds]);
  const [upload,setUpload]=useState<UploadProgress>(null);const [uploadToComposer,setUploadToComposer]=useState(false);const [optimisticAssets,setOptimisticAssets]=useState<MediaAsset[]>([]);
  useEffect(()=>{if(ai?.workflowActive===false)saves.retry();},[ai?.workflowActive,saves]);
  useEffect(()=>{saves.receive({timeline:project.timeline??{...EMPTY_TIMELINE,aspectRatio:project.aspectRatio},revision:project.revision??0,history:project.history??[]});},[project,saves]);
  // The switched project has arrived (and was received above): the real timeline takes over.
  useEffect(()=>{if(pendingTab&&(project.activeTimelineId??'main')===pendingTab.id)setPendingTab(null);},[project.activeTimelineId,pendingTab]);
  const assets=useMemo<MediaAsset[]>(()=>[...(media??[]),...optimisticAssets.filter(asset=>!media?.some(a=>a._id===asset._id))].map((asset:MediaAsset)=>{
    const linkedAudio=[...media??[],...optimisticAssets].some(video=>video.audioAssetId===asset._id);
    const progress=linkedAudio?90:preparedFootageProgress(asset,mediaTasks);
    const analysis=mediaTasks?.find(task=>task.assetId===asset._id&&task.kind==='transcribe'&&!asset.analysisKinds?.includes('transcribe')&&!asset.analysis?.transcript);
    if(analysis&&analysis.status!=='completed'){
      const failed=analysis.status==='failed'||analysis.status==='cancelled';
      return {...asset,footageProgress:progress,preparation:{status:failed?'failed' as const:'processing' as const,message:failed?'Media analysis failed. Retry preparation.':mediaTaskActivityLabel(analysis)}};
    }
    if(asset.kind!=='video'||asset.audioExtracted||asset.audioAssetId)return {...asset,footageProgress:progress};
    const task=mediaTasks?.find(task=>task.kind==='extract'&&task.assetId===asset._id);
    const failed=task?.status==='failed'||task?.status==='cancelled';
    return {...asset,footageProgress:progress,preparation:{status:failed?'failed' as const:'processing' as const,message:failed?'Audio preparation failed.':'Preparing audio…'}};
  }),[media,optimisticAssets,mediaTasks]);
  const footageProgress=useMemo(()=>aggregateFootageProgress(assets.filter(asset=>timeline.clips.some(clip=>clip.assetId===asset._id)&&!assets.some(video=>video.audioAssetId===asset._id)).map(asset=>({percent:preparedFootageProgress(asset,mediaTasks),size:asset.size}))),[assets,timeline.clips,mediaTasks]);
  const videoImports=useMemo(()=>mediaTasks?.filter(task=>task.kind==='import').map(task=>{
    const asset=assets.find(asset=>asset._id===task.assetId);
    const progress=asset?preparedFootageProgress(asset,mediaTasks):transferProgress(task.progress);
    const preparing=task.status==='completed'&&(!asset||progress<90);
    return {...task,progressKey:asset?`asset:${asset._id}`:`task:${task._id}`,overallProgress:progress,status:preparing?'preparing':task.status};
  }),[mediaTasks,assets]);
  const handleEditorOpened=useCallback(()=>{
    for(const asset of assets){
      if(asset.kind!=='video'||!asset.audioExtracted||requestedOverviews.current.has(asset._id))continue;
      if(asset.audioAssetId&&!asset.analysisKinds?.includes('transcribe')&&!asset.analysis?.transcript)continue;
      if(asset.analysisKinds?.includes('understand')||asset.analysis?.understanding)continue;
      requestedOverviews.current.add(asset._id);
      // The backend reads the saved transcript before deciding whether an overview is useful.
      void startOverview({projectId,assetId:asset._id as Id<'assets'>}).catch(()=>{});
    }
  },[assets,projectId,startOverview]);
  // Each stored tab's first shot, shown in the export picker.
  // Motion-only tabs are previewed by their first scene's rendered frame.
  const tabSceneIds=useMemo(()=>(tabSnapshots??[]).flatMap(item=>item.timeline.clips.filter(clip=>clip.kind==='scene').sort((a,b)=>a.start-b.start).slice(0,1).map(clip=>clip.id)),[tabSnapshots]);
  const tabSceneThumbs=useSceneThumbs('forClips',tabSceneIds.length?{projectId:project._id,clipIds:tabSceneIds}:'skip');
  const tabCovers=useMemo(()=>new Map(tabSnapshots?.map(item=>[item.id,timelineCover(normalizeTimeline(item.timeline),assets,tabSceneThumbs)])),[tabSnapshots,assets,tabSceneThumbs]);
  const requestedPreviews=useRef(new Set<string>());
  const [previewPreparationError,setPreviewPreparationError]=useState('');
  const [playbackOpeningGate]=useState(createPlaybackOpeningGate);
  useEffect(()=>{
    const used=new Set((activePreview?.timeline??timeline).clips.filter(clip=>clip.kind==='video').map(clip=>clip.assetId));
    const legacy=assets.filter(asset=>asset.kind==='video'&&used.has(asset._id)&&!asset.previewUrl&&!requestedPreviews.current.has(asset._id)).map(asset=>asset._id);
    if(!legacy.length)return;
    for(const id of legacy)requestedPreviews.current.add(id);
    void preparePlayback({projectId,assetIds:legacy as Id<'assets'>[]}).catch(()=>{
      // Mounted sessions keep their source while preparation retries. An initial
      // large source waits below; this is not a failed upload or saved edit.
      console.warn('[Revline playback preparation]',JSON.stringify({reason:'background preview preparation unavailable',sources:legacy.length}));
      setPreviewPreparationError('Could not prepare this footage for editing. Your original footage and saved edit are intact.');
    });
  },[assets,timeline,activePreview?.timeline,preparePlayback,projectId]);
  const commit=useCallback((next:Timeline,undo=false)=>{timelineRef.current=next;if(store.getState().timeline!==next)store.getState().replace(next);saves.edit(next,undo,undo?store.getState().history:undefined);},[saves]);
  const change=useCallback((next:Timeline)=>{store.getState().edit(next);setError('');commit(store.getState().timeline);},[commit]);
  // The store starts with the complete bounded server history. Falling back to
  // server undo after consuming it would replay snapshots created by local undo.
  const undo=useCallback(()=>{const previous=store.getState().undo();if(previous)commit(previous,true);},[store,commit]);
  const redo=useCallback(()=>{const next=store.getState().redo();if(next)commit(next);},[store,commit]);
  const assistantEditSnapshot=useMemo<AssistantEditSnapshot|undefined>(()=>{
    const before=project.history?.at(-1);if(!before)return undefined;
    const after=normalizeTimeline(project.timeline??{...EMPTY_TIMELINE,aspectRatio:project.aspectRatio});
    const snapshot={before:normalizeTimeline(before),after,revision:project.revision??0};
    return {...snapshot,canUndo:!saving&&!ai?.running&&history.length>0&&matchesUndoSnapshot(snapshot,timeline,history.at(-1)??before),publishedDraft:!ai?.running&&project.aiUndoRecorded===true&&project.aiCheckpointRevision===snapshot.revision};
  },[project.history,project.timeline,project.aspectRatio,project.revision,project.aiUndoRecorded,project.aiCheckpointRevision,timeline,history,saving,ai?.running]);
  const aiStarting=useRef(false);
  const preparingAudio=useRef<Promise<void>|null>(null);const failedAudio=useRef(new Set<string>());const [audioBusy,setAudioBusy]=useState(false);
  useEffect(()=>{
    if(media===undefined||ai===undefined||aiStarting.current||preparingAudio.current||audioBusy||ai.running||upload||uploading.current)return;
    const source=assets.find(asset=>asset.kind==='video'&&!failedAudio.current.has(asset._id)&&timeline.clips.some(clip=>clip.assetId===asset._id&&!clip.audioSeparated))??assets.find(asset=>asset.kind==='audio'&&!asset.waveform&&!failedAudio.current.has(asset._id)&&timeline.clips.some(clip=>clip.assetId===asset._id));
    if(!source)return;
    setAudioBusy(true);
    const task=(async()=>{
      if(source.kind==='audio'){
        await prepareAudioWaveform(convex,projectId,source._id as Id<'assets'>);
        failedAudio.current.add(source._id);
        return;
      }
      if(!source.audioExtracted)await prepareVideoAudio(convex,projectId,source._id as Id<'assets'>);
      const video=await convex.query(api.assets.get,{projectId,assetId:source._id as Id<'assets'>});
      if(video.audioAssetId){
        const audio=await convex.query(api.assets.get,{projectId,assetId:video.audioAssetId});
        setOptimisticAssets(previous=>[...previous.filter(a=>a._id!==video._id&&a._id!==audio._id),video,audio]);
        const next=separateVideoClips(timelineRef.current,video);
        if(next!==timelineRef.current){change(next);await saves.wait();}
        if(timelineRef.current.clips.some(clip=>clip.assetId===video._id&&!clip.audioSeparated))throw new Error('Could not save the separated audio. Try reopening this project.');
      }
      failedAudio.current.add(source._id);
    })().catch(e=>{failedAudio.current.add(source._id);setError(userError(e, 'Could not separate this video’s audio.'));}).finally(()=>{preparingAudio.current=null;setAudioBusy(false);});
    preparingAudio.current=task;
  },[media,assets,timeline,ai?.running,upload,audioBusy,convex,projectId,change,saves]);
  const titleChange=async(value:string)=>{await update({projectId,title:value});setTitle(value);};
  const waitForSave=()=>saves.wait();
  // The turn works on the tab on screen, even if another agent opens a different tab meanwhile.
  const shownTab=watchedTab??pendingTab?.id??project.activeTimelineId;
  const filmDraft=ai?.running&&storedFilmDraft&&storedFilmDraft.timelineId===(shownTab??timelineTabs?.[0]?.id??'main')?storedFilmDraft as FilmDraftView:undefined;
  const sendRequest=async(prompt:string,context:Omit<Parameters<typeof send>[0],'projectId'|'prompt'>&{retryPromptMessageId?:string}={})=>{
    aiStarting.current=true;
    const {retryPromptMessageId,...requestContext}=context;
    if(retryPromptMessageId){try{await waitForSave();await retryTurn({projectId,promptMessageId:retryPromptMessageId});}finally{aiStarting.current=false;}return;}
    const attached=[...composerAssetIds];
    try{if(!ai?.running&&!isCasualChat(prompt)){await preparingAudio.current;await waitForSave();}await send({projectId,prompt,...requestContext,...(shownTab?{timelineId:shownTab}:{}),...(attached.length?{attachedAssetIds:attached as Id<'assets'>[]}: {})});setComposerAssetIds(previous=>previous.filter(id=>!attached.includes(id)));}
    finally{aiStarting.current=false;}
  };

  const uploading=useRef(false);
  async function handleUpload(files:File[],{requireAll=false,addToTimeline=true,attach=addToTimeline}:{requireAll?:boolean;addToTimeline?:boolean;attach?:boolean}={}){
    if(uploading.current||!files.length)return;if(!timelineRef.current.clips.length)beginFootageOpening(projectId);uploading.current=true;setUploadToComposer(attach);setError('');
    const failed=(file:File,e:unknown)=>{console.error(`[upload] ${file.name} failed`,e);setError(userError(e,`Could not import “${file.name}”. Please try adding it again.`));};
    let incomplete=false;
    // Cancel stops the current and remaining transfers; finished sources stay.
    const cancellation=new AbortController();
    const cancel=()=>cancellation.abort(new DOMException('Upload cancelled.','AbortError'));
    const queue = files.map(file => ({id:crypto.randomUUID(),name:file.name,percent:0,kind:(file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':'video') as 'video'|'image'|'audio',error:undefined as string|undefined}));
    const transferred:{file:File;index:number;assetId:Id<'assets'>}[]=[];
    const batchKey=`upload:${crypto.randomUUID()}`;
    const report=(index:number,percent:number,phase:NonNullable<UploadProgress>['phase'])=>{
      const file=files[index];queue[index].percent=Math.max(queue[index].percent,percent);
      const assetId=transferred.find(item=>item.index===index)?.assetId;
      if(assetId)rememberFootageProgress(`asset:${assetId}`,queue[index].percent);
      const overall=rememberFootageProgress(batchKey,aggregateFootageProgress(queue.map((item,i)=>({percent:item.percent,size:files[i].size}))));
      if(!timelineRef.current.clips.length)rememberFootageProgress(`project:${projectId}`,overall);
      setUpload({name:file.name,size:file.size,index:index+1,total:files.length,percent:overall,phase,queue:queue.map(item=>({...item})),...(phase==='reading'||phase==='uploading'?{onCancel:cancel}:{})});
    };
    try{
      // Completion starts durable preparation on the server. Transfer the next
      // source while those tasks run instead of waiting for each AI analysis.
      for(const [index,file] of files.entries()){
        if(cancellation.signal.aborted){incomplete=true;break;}
        try{
          const assetId=await uploadSourceFile(file,sourceUpload.transport(projectId,file),(percent,phase)=>report(index,phase==='reading'?0:transferProgress(percent),phase),cancellation.signal);
          transferred.push({file,index,assetId});
        }catch(e){incomplete=true;if(!cancellation.signal.aborted)failed(file,e);}
      }
      // Cancelled files must not resume from the local draft on the next open.
      if(cancellation.signal.aborted)await acknowledgeDraftFiles(files.filter(file=>!transferred.some(item=>item.file===file))).catch(()=>undefined);
      // Keep timeline writes ordered, and acknowledge each local draft only
      // after its preparation and requested timeline attachment have succeeded.
      for(const {file,index,assetId} of transferred){
        report(index,25,'saving');
        try{
          let asset:MediaAsset=await convex.query(api.assets.get,{projectId,assetId});
          if(asset.kind!=='image')asset=await prepareMediaForEditing(convex,projectId,assetId,status=>{
            report(index,status.percent,status.phase==='processing'?'preparing':status.phase);
            setUpload(current=>current?{...current,activity:status.activity}:current);
          });
          rememberFootageProgress(`asset:${assetId}`,preparedFootageProgress(asset));
          report(index,preparedFootageProgress(asset),'saving');
          const audio=asset.audioAssetId?await convex.query(api.assets.get,{projectId,assetId:asset.audioAssetId as Id<'assets'>}):null;
          setOptimisticAssets(previous=>[...previous.filter(item=>item._id!==asset._id&&item._id!==audio?._id),asset,...(audio?[audio]:[])]);
          if(attach)setComposerAssetIds(previous=>[...new Set([...previous,asset._id])]);
          if(addToTimeline){
            change(addMediaClip(timelineRef.current,asset,crypto.randomUUID()));
            await waitForSave();
            if(!timelineRef.current.clips.some(clip=>clip.assetId===assetId))throw new Error('Your footage uploaded, but its clip could not be saved. Please retry the import.');
          }
          await acknowledgeDraftFiles([file]);
          const prepared=preparedFootageProgress(asset);
          report(index,prepared>=90?100:prepared,'saving');
        }catch(e){incomplete=true;failed(file,e);}
      }
    }finally{uploading.current=false;setUpload(null);setUploadToComposer(false);}
    if(requireAll&&cancellation.signal.aborted)throw new Error('Upload cancelled. Your request is still saved; add your footage when you’re ready to start the edit.');
    if(requireAll&&incomplete)throw new Error('Some footage could not be imported. Your request is still saved; retry the missing files before starting the edit.');
  }
  async function exportVideo(settings:ExportSettings){await saves.wait();const id=await renderStart({projectId,...settings});setJobId(id);return id as string;}
  const latestExport=job??jobs?.[0]??null;
  // Unsaved edits land in the open tab before another one opens.
  const tabActions=useMemo(()=>({
    onOpen:async(timelineId:string)=>{
      if(aiBusyRef.current){setViewTab(timelineId===(project.activeTimelineId??'main')?null:timelineId);return;}
      const snapshot=tabSnapshots?.find(item=>item.id===timelineId);
      if(snapshot)startTransition(()=>setPendingTab({id:timelineId,timeline:normalizeTimeline(snapshot.timeline)}));
      try{await saves.wait();await openTab({projectId,timelineId});}catch(error){setPendingTab(null);throw error;}
    },
    onCreate:async(from:'blank'|'duplicate')=>{await saves.wait();await createTab({projectId,from});},
    onRename:async(timelineId:string,name:string)=>{await renameTab({projectId,timelineId,name});},
    onRemove:async(timelineId:string)=>{await saves.wait();await removeTab({projectId,timelineId});},
  }),[saves,openTab,createTab,renameTab,removeTab,projectId,tabSnapshots,project.activeTimelineId]);
  useEffect(()=>{if(!viewTab||aiBusy)return;const id=viewTab;setViewTab(null);void tabActions.onOpen(id).catch(setError);},[aiBusy,viewTab,tabActions]);
  const exportList=useMemo(()=>(jobs??[]).map(item=>({...item,current:item.sourceRevision===(project.revision??0)&&!saves.busy,requestId:item._id})),[jobs,project.revision,saves.busy]);
  const exportState=latestExport?{...latestExport,current:latestExport.sourceRevision===(project.revision??0)&&!saves.busy,requestId:latestExport._id}:null;
  const handoffStarted=useRef(false);
  useEffect(()=>{
    // The plan decides whether the opening brief can go to the in-app agent (Revline MCP cannot).
    if(handoffStarted.current||media===undefined||plan===undefined)return;
    handoffStarted.current=true;
    void(async()=>{
      const files=await takeFiles();
      if(files.length)await handleUpload(files,{requireAll:true});
      await waitForSave();
      // A reference to recreate stays off the timeline; the brief goes out with it attached.
      const {prompt,reference}=openingBrief(projectId);
      const references=reference?(media??[]).filter(asset=>asset.kind==='video'||asset.kind==='image').map(asset=>asset._id as Id<'assets'>):[];
      // A project started from a prompt has no footage; its brief goes out as the first request.
      const blank=!files.length&&!(media??[]).length;
      if(prompt&&plan!=='mcp'&&(timelineRef.current.clips.length||reference||blank)&&!saves.busy){await sendRequest(prompt,{...openingRequestOptions(projectId,{models:EDITOR_MODELS.map(model=>model.id),efforts:EDITOR_REASONING_EFFORTS}),...(references.length?{attachedAssetIds:references}:{})});clearOpeningBrief(projectId);}
      clearOpeningRequestOptions(projectId);
    })().catch(e=>setError(userError(e, 'Could not start this edit.')));
  },[media,projectId,send,plan]);
  if(media===undefined)return editorLoading(projectId);
  const pendingPlayback=playbackOpeningGate(activePreview?.timeline??timeline,assets);
  if(pendingPlayback.length){
    const tasks=pendingPlayback.map(asset=>mediaTasks?.find(task=>task.kind==='preview'&&task.assetId===asset._id));
    const failed=tasks.some(task=>task?.status==='failed'||task?.status==='cancelled');
    const task=tasks.find(task=>task?.status==='running')??tasks[0];
    const preparingAsset=pendingPlayback.find(asset=>asset._id===task?.assetId)??pendingPlayback[0];
    const error=previewPreparationError||(failed?'Could not prepare this footage for editing. Your original footage and saved edit are intact.':'');
    return <div className="editor-app footage-preparation-boot"><WorkspaceNav title={title}/><FootagePreparation thumbnail={preparingAsset.thumbnailUrl??openingFootage(projectId)?.thumbnail} fileName={preparingAsset.fileName} progressKey={`project:${projectId}`} progress={footageProgress} label={task?.status==='retrying'?'Retrying playback preparation…':'Preparing playback…'} activity={task?.status==='queued'?'Queued for playback preparation…':task?.activity==='downloading'?'Loading your footage…':task?.progress===100?'Saving your editing preview…':'Optimizing footage for smooth editing…'} detail="Your footage is saved. The editor opens when the footage on your timeline is ready." error={error} onRetry={error?()=>{setPreviewPreparationError('');void preparePlayback({projectId,assetIds:pendingPlayback.map(asset=>asset._id as Id<'assets'>)}).catch(()=>setPreviewPreparationError('Could not prepare this footage for editing. Your original footage and saved edit are intact.'));}:undefined}/></div>;
  }
  return <EditorStateProvider store={store}><EditorShell footageProgress={footageProgress} onOpened={handleEditorOpened} ultra={plan==='ultra'} assistantUpgrade={plan==='mcp'?<ProUpgradeCard trialing={!!planStatus?.trialing}/>:undefined} sceneThumbs={sceneThumbs} sceneRendering={sceneRendering} onRegisterStockAudio={async catalogId=>{await waitForSave();const asset=await registerStockAudio({projectId,catalogId});setOptimisticAssets(previous=>[...previous.filter(item=>item._id!==asset._id),asset]);return asset;}} onShare={()=>setShareOpen(true)} onSaveThumbnail={persistThumbnail} projectId={projectId} draftKey={editorDraftKey(projectId)} title={title} onTitle={titleChange} timeline={viewedTimeline??pendingTimeline??activePreview?.timeline??timeline} switchingTimeline={!!pendingTab||!!viewedTimeline} liveEdit={viewedTimeline?undefined:activePreview??undefined} filmDraft={filmDraft} assets={assets} composerAttachments={[...composerMedia(assets,composerAssetIds),...(uploadToComposer?upload?.queue??[]:[]).map(item=>({id:`upload:${item.id}`,name:item.name,kind:item.kind,progress:item.percent,error:item.error}))]} composerBusy={!!upload&&uploadToComposer} onRemoveComposerAttachment={id=>setComposerAssetIds(previous=>previous.filter(value=>value!==id))} onAttachAsset={id=>setComposerAssetIds(previous=>[...new Set([...previous,id])])} onRemoveAsset={async asset=>{await waitForSave();await removeAsset({assetId:asset._id as Id<'assets'>});setComposerAssetIds(previous=>previous.filter(id=>id!==asset._id));store.setState(state=>({history:state.history.filter(edit=>!edit.clips.some(clip=>clip.assetId===asset._id)),future:state.future.filter(edit=>!edit.clips.some(clip=>clip.assetId===asset._id))}));setOptimisticAssets(previous=>previous.filter(item=>item._id!==asset._id));}} onRefreshMedia={handleRefreshMedia} onChange={change} saving={saving} saveFailed={saveFailed&&!saving} onRetrySave={()=>saves.retry()} upload={upload} error={error} onError={setError} onUndo={undo} onRedo={redo} canUndo={!!history.length} canRedo={!!future.length} assistantEditSnapshot={assistantEditSnapshot} canResumeEdit={!!project.aiRecovery?.requests.length} messages={EMPTY_MESSAGES} conversation={project.threadId?{projectId,threadId:project.threadId}:undefined} aiRunning={ai?.running??false} externalAgent={externalAgent} aiEditing={ai?.editing??false} aiWorkflowActive={ai?.workflowActive} aiConfigured={ai?.configured??false} assistantSettings={{catalogModels:ai?.catalogModels,modelAccessNeedsSync:ai?.modelAccessNeedsSync,paidModelAccess:ai?.paidModelAccess,modelSwitcher:ai?.modelSwitcher??false,effortSwitcher:ai?.effortSwitcher??false,allowedModels:ai?.allowedModels,claudeViaMcp:ai?.claudeViaMcp,defaultModelChoice:ai?.defaultModelChoice,defaultReasoningEffort:ai?.defaultReasoningEffort}} aiError={ai?.error} onStop={async()=>{await stop({projectId});}} onSend={sendRequest} onExport={exportVideo} onDownloadExport={async jobId=>{window.location.assign(await downloadExport({jobId:jobId as Id<'renderJobs'>}));}} onCancelExport={jobId=>renderCancel({jobId:jobId as Id<'renderJobs'>}).then(()=>{})} exportState={exportState} exports={exportList} timelineTabs={viewedTimeline?timelineTabs?.map(tab=>({...tab,active:tab.id===watchedTab,editing:tab.active,cover:tabCovers.get(tab.id)})):pendingTab?timelineTabs?.map(tab=>({...tab,active:tab.id===pendingTab.id})):timelineTabs?.map(tab=>tab.active?{...tab,aspectRatio:timeline.aspectRatio,duration:timelineDuration(timeline),clipCount:timeline.clips.length}:{...tab,cover:tabCovers.get(tab.id)})} timelineTabActions={tabActions} mcpConnection={mcpConnection} onUpload={handleUpload} onDropUpload={files=>handleUpload(files,{addToTimeline:false})} onAttachUpload={files=>handleUpload(files,{addToTimeline:!timelineRef.current.clips.length,attach:true})} onImportVideo={async url=>{await waitForSave();const imported=await importVideo({projectId,url});setComposerImportIds(previous=>[...previous,imported.taskId]);}} videoImports={videoImports} analysisBusy={ai?.activity} analysisSource={ai?.activitySource} analysisProgress={ai?.activityProgress} analysisStartedAt={ai?.activityStartedAt} assistantBudgetUsed={ai?.budgetUsed} preparationActivity={!ai?.running?assets.find(asset=>asset.preparation?.status==='processing'&&timeline.clips.some(clip=>clip.assetId===asset._id))?.preparation?.message:undefined}/><ConnectedTimelineShareDialog projectId={projectId} sceneThumbs={sceneThumbs} open={shareOpen} onOpenChange={setShareOpen} title={title} timeline={timeline} assets={assets} onBeforePublish={waitForSave} publishDisabled={!!ai?.running || !timeline.clips.length}/></EditorStateProvider>;
}
