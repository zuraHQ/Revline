'use client';
import { userError } from '@/lib/user-error';
import { clipExportTimeline } from '@/lib/editor/clip-export';
import { MAX_EXPORT_LABEL, MAX_EXPORT_SECONDS } from '@/lib/editor/limits';
import { addTimelineMarker } from '@/lib/editor/timeline-markers';
import { withFilmDraft, type FilmDraftView } from '@/lib/editor/film-draft-view';

import { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { Plus, MessageSquare, Film, LoaderCircle, RotateCcw, X, Play, Pause } from 'lucide-react';
import { useEditorStore, useEditorState } from './editor-state';
import { usePanelRef } from 'react-resizable-panels';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Sheet,SheetContent,SheetTitle,SheetDescription } from '@/components/ui/sheet';
import { WorkspaceNav } from '@/components/workspace/workspace-nav';
import { ProjectImportStage } from './project-entry';
import { openingFootage, releaseOpeningFootage } from '@/lib/editor/footage-opening';
import { rememberFootageProgress, useFootageProgress } from '@/lib/editor/footage-progress-store';
import { Progress } from '@/components/ui/progress';
import { FootagePreparation } from './footage-preparation';
import { editorAudioPrepared, timelineThumbnailsPrepared, MAX_THUMBNAIL_OPENING_WAIT_MS } from '@/lib/editor/editor-opening';
import { PlaybackTime } from './playback-time';
import { Preview, type PreviewHandle } from './preview';
import { usePlaybackSources } from './use-playback-sources';
import { PreviewZoomProvider, PreviewViewport, PreviewFrameOverlay } from './preview-zoom';
import { CanvasSettings } from './canvas-settings';
import { AspectRatioControl } from './aspect-ratio-control';
import type { SafeAreaPlatform } from '@/lib/editor/safe-areas';
import { MediaImportDialog } from './media-import-dialog';
import { PreviewInspector } from './preview-inspector';
import { MediaTab } from './media-tab';
import { TimelinePanel } from './timeline';
import type { VideoImportState } from './video-link-import';
import type { UploadProgress } from './footage-panel';
import type { ClaudeModelChoice,EditorReasoningEffort,EditorSpeedMode } from '@/lib/ai/claude-model';
import type { ComposerSettings } from './assistant-composer-controls';
import { AssistantPanel } from './assistant-panel';
import type { ChatMessage } from './chat-types';
import type { ComposerAttachment } from '@/lib/editor/composer-media';
import type { AssistantEditSnapshot } from './assistant-results';
import { ExportDialog, type ExportSettings, type ExportState } from './export-dialog';
import type { TimelineTab, TimelineTabActions } from './timeline-tabs';
import { EditorErrorNotice } from './error-notice';
import { type Timeline, type MediaAsset, type AspectRatio, type Clip, timelineDuration, dimensions } from '@/lib/editor/types';
import { timelineCover } from '@/lib/editor/timeline-cover';
import { addMediaClip, addTextClip, patchClip, frameSeekTime, linkedClipIds } from '@/lib/editor/operations';
import { textLookPatch, type TextLookId } from '@/lib/editor/text-looks';
import { copyTimelineClips, pasteTimelineClips } from '@/lib/editor/clipboard';
import type { RefreshPlaybackMedia } from '@/lib/editor/media-source-recovery';
import { MediaFileDropOverlay, useMediaFileDrop } from './media-file-drop';
import { SegmentedTabs } from './segmented-tabs';
import { useStoredPreference } from './use-stored-preference';
import { readStoredPreference, writeStoredPreference } from '@/lib/stored-preference';
import { TextFontStyles } from './text-font-styles';
import './editor-mode.css';
import './live-edit.css';
import type { LiveEditChange } from '@/lib/editor/live-edit';

const NO_SELECTED_CLIPS:string[]=[];
export type EditContext = { selectedClipId?: string; selectedClipIds?:string[]; playhead: number; modelChoice?: ClaudeModelChoice; reasoningEffort?: EditorReasoningEffort; speedMode?: EditorSpeedMode; retryPromptMessageId?: string };
export type EditorShellProps = {
  title: string; timeline: Timeline; assets: MediaAsset[]; onChange: (t: Timeline) => void;
  onTitle: (title: string) => void; onUpload: (files: File[]) => Promise<void>;
  onDropUpload: (files: File[]) => Promise<void>;
  /** The chat's Add footage: attach to the next message without appending to the timeline. */
  onAttachUpload?: (files: File[]) => Promise<void>;
  footageProgress?: number; saving: boolean; saveFailed?: boolean; onRetrySave?: () => void; upload: UploadProgress; error: string; onError: (message: string) => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
  conversation?:{projectId:import('@/convex/_generated/dataModel').Id<'projects'>;threadId:string}; messages: ChatMessage[]; aiRunning: boolean; externalAgent?: string | null; aiEditing?:boolean; aiWorkflowActive?:boolean; aiConfigured: boolean;
  /** The model and effort choices offered in the conversation's composer. */
  assistantSettings?: ComposerSettings; aiError?: string | null; draftKey?:string;
  onSend: (text: string, context?: EditContext) => Promise<void>;
  composerAttachments?: ComposerAttachment[]; composerBusy?: boolean; onRemoveComposerAttachment?: (id:string)=>void;
  onStop?: () => Promise<void>;
  liveEdit?:LiveEditChange & {sequence:number;runId:string};
  /** A film the editor agent is still writing: shown in the preview and on its own track, never saved or exported. */
  filmDraft?:FilmDraftView;
  /** Rendered frames of each motion clip, by clip id. */
  sceneThumbs?:Record<string,{time:number;image:string}[]>;
  sceneRendering?:readonly string[];
  canResumeEdit?:boolean;
  assistantEditSnapshot?:AssistantEditSnapshot;
  assistantPanel?: ReactNode;
  onExport: (settings: ExportSettings) => Promise<string | void>; onDownloadExport?: (jobId:string)=>Promise<void>; onCancelExport?: (jobId:string)=>Promise<void>; exportState: ExportState; exports?: NonNullable<ExportState>[]; timelineTabs?: TimelineTab[]; timelineTabActions?: TimelineTabActions; /** The app connected over MCP (its name), null when none is, undefined while loading. */ mcpConnection?: string | null; switchingTimeline?: boolean; demo?: boolean; ultra?: boolean; /** Replaces the agent composer when the plan cannot edit by prompting. */ assistantUpgrade?: ReactNode;
  analysisBusy?: string | null; analysisSource?: string | null; analysisProgress?: number | null; analysisStartedAt?:number|null; assistantBudgetUsed?:number; preparationActivity?:string; onLoadMore?: () => void; canLoadMore?: boolean;
  projectId?: string; onImportVideo?: (url:string)=>Promise<void>; videoImports?: VideoImportState[];
  onRefreshMedia?:RefreshPlaybackMedia;
  onRemoveAsset?: (asset:MediaAsset)=>Promise<void>;
  /** Sends media already in the project with the next chat message. */
  onAttachAsset?: (assetId:string)=>void;
  onSaveThumbnail?: (assetId:string,url:string)=>void;
  onPreviewReady?: (controller:PreviewHandle)=>void;
  onOpened?: () => void;
  onRegisterStockAudio?: (catalogId:string)=>Promise<MediaAsset>;
  onShare?: () => void;
};

const TIMELINE_MIN_HEIGHT = 160;
const INSPECTOR_OPEN_KEY = 'revline-inspector-open';
const SAFE_AREA_KEY = 'revline.safeArea';
const MCP_CHAT_CLOSED_KEY = 'revline.mcpChatClosed';
const decodeOpen = (stored: string | null) => stored === 'true';
const TIMELINE_MAX_SHARE = .65;
/** A panel's imperative API throws until its group has measured it (first paint, leaving compact); until then there is nothing to read or move. */
const measured = <T,>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };

export function EditorShell(p: EditorShellProps) {
  const { timeline, assets, onError } = p;
  const { timelineAssets, onPlaybackAssets } = usePlaybackSources(assets);
  const retainedPreview=useRef(timeline);
  useLayoutEffect(()=>{if(timeline.clips.length||!p.liveEdit)retainedPreview.current=timeline;},[timeline,p.liveEdit]);
  const editedPreview=p.liveEdit&&!timeline.clips.length?retainedPreview.current:timeline;
  const previewTimeline=useMemo(()=>withFilmDraft(editedPreview,p.filmDraft),[editedPreview,p.filmDraft]);
  // Status fields can arrive before the workflow flag updates. Any positive
  // run-scoped editing/analysis evidence locks interactions; a plain reply has none.
  const scriptedWorkflow = !!p.demo && p.aiWorkflowActive === undefined && p.aiEditing === undefined;
  // A connected MCP agent counts as working for its whole request, between its tool calls too.
  const aiWorking = !!p.externalAgent || !!p.aiRunning && (p.aiWorkflowActive === true || p.aiEditing === true || !!p.analysisBusy || scriptedWorkflow);
  // A tab switch also pauses editing until the server confirms, but it is not AI work.
  const editing = p.switchingTimeline === true || aiWorking;
  const editLock = useRef(editing);
  const manualSession = useMemo(() => Symbol('manual-edit-session'), [editing]);
  const currentManualSession = useRef(manualSession);
  useLayoutEffect(() => { editLock.current = editing; currentManualSession.current = manualSession; }, [editing, manualSession]);
  // Gesture and async callbacks may outlive the render that started them.
  const onChange = useCallback((next: Timeline) => { if (!editLock.current && currentManualSession.current === manualSession) p.onChange(next); }, [p.onChange, manualSession]);
  const undo = useCallback(() => { if (!editLock.current) p.onUndo(); }, [p.onUndo]);
  const redo = useCallback(() => { if (!editLock.current) p.onRedo(); }, [p.onRedo]);
  function changeClip(id: string, patch: Partial<Clip>) {
    if (editLock.current) return;
    try { onChange(patchClip(timeline, id, patch)); }
    catch (error) {
      const joinedBlend = patch.blendMode !== undefined && timeline.clips.some(clip => clip.transition?.fromClipId === id || clip.transition?.toClipId === id);
      onError(userError(error, 'Could not change this clip.') + (joinedBlend ? ' Remove the transition before changing the blend mode of just one connected clip.' : ''));
    }
  }
  const usedAssetIds=useMemo(()=>timeline.clips.flatMap(clip=>clip.assetId?[clip.assetId]:[]),[timeline.clips]);
  const dismissError = useCallback(() => onError(''), [onError]);
  const params = useSearchParams();
  const [compact,setCompact]=useState(false);useEffect(()=>{const media=matchMedia('(max-width:900px)');const update=()=>setCompact(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const [importOpen,setImportOpen]=useState(false);const [importDestination,setImportDestination]=useState<'timeline'|'sources'|'composer'>('timeline');
  const store=useEditorStore();const selected=useEditorState(s=>s.selectedId);const selectedIds=useEditorState(s=>s.selectedIds??NO_SELECTED_CLIPS);const setSelected=(id:string|null)=>store.setState({selectedId:id,selectedIds:id?[id]:[]});
  const [clipboard, setClipboard] = useState<Clip[]>([]);
  // Safe-area preview is a per-browser viewing preference, not part of the edit.
  const [safeArea,setSafeArea]=useState<SafeAreaPlatform|null>(null);
  useEffect(()=>{const saved=readStoredPreference(SAFE_AREA_KEY);if(saved==='instagram'||saved==='tiktok')setSafeArea(saved);},[]);
  const changeSafeArea=useCallback((next:SafeAreaPlatform|null)=>{setSafeArea(next);writeStoredPreference(SAFE_AREA_KEY,next);},[]);
  useEffect(() => { setClipboard([]); }, [p.projectId]);
  const [croppingClip, setCroppingClip] = useState<string | null>(null);
  useEffect(() => { if (editing) setCroppingClip(null); }, [editing]);
  // Clock-dependent leaves subscribe to position; the workspace itself does
  // not rebuild for playback ticks or pointer scrubbing.
  const time=store.getState().playhead;const setTime=useCallback((playhead:number)=>store.setState({playhead}),[store]);
  const playing=useEditorState(s=>s.playing);const setPlaying=useCallback((playing:boolean)=>store.setState({playing}),[store]);
  const muted=useEditorState(s=>s.muted);const setMuted=(muted:boolean)=>store.setState({muted});
  const [exportOpen, setExportOpen] = useState(params.get('export') === '1');
  const [exportClipId,setExportClipId]=useState<string|null>(null);
  // Several tabs: the dialog picks which timelines to export, starting with the open one.
  const tabs=p.timelineTabs??[],activeTabId=tabs.find(tab=>tab.active)?.id;
  const [exportTabs,setExportTabs]=useState<string[]>([]);
  useEffect(()=>{if(exportOpen&&activeTabId)setExportTabs([activeTabId]);},[exportOpen,activeTabId]);
  const multiTab=tabs.length>1&&!exportClipId;
  const onlyOpenTab=!multiTab||(exportTabs.length===1&&exportTabs[0]===activeTabId);
  const exportTimeline=useMemo(()=>{
    if(!exportClipId)return timeline;
    try{return clipExportTimeline(timeline,exportClipId);}catch{return {...timeline,clips:[]};}
  },[timeline,exportClipId]);
  // Each target shows its own latest export; others keep rendering in the list.
  const exportState=useMemo(()=>{
    if(!onlyOpenTab)return null;
    const matches=(job:NonNullable<ExportState>)=>(job.sourceClipId??null)===exportClipId&&(!activeTabId||!job.sourceTimelineId||job.sourceTimelineId===activeTabId);
    const latest=[p.exportState,...p.exports??[]].filter((job):job is NonNullable<ExportState>=>!!job&&matches(job)).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0))[0];
    return latest??null;
  },[p.exportState,p.exports,exportClipId,onlyOpenTab,activeTabId]);
  // The export preview is the first shot of the video being exported.
  const exportCover=useMemo(()=>timelineCover(exportTimeline,assets),[exportTimeline,assets]);
  // Returns the started job ids so the dialog can follow a batch of several videos.
  const startExports=async(settings:ExportSettings):Promise<string[]>=>{
    const started:string[]=[],start=async(next:ExportSettings)=>{const id=await p.onExport(next);if(id)started.push(id);};
    if(!onlyOpenTab){for(const timelineId of exportTabs)await start({...settings,timelineId});}
    else await start({...settings,...(exportClipId?{clipId:exportClipId}:{})});
    return started;
  };
  // Phones open on the conversation.
  const [mobileConversation, setMobileChat] = useState(true);
  const mobileChat = compact && mobileConversation;
  // The media panel stays mounted so it can slide open and closed; widths animate only during a toggle, never while dragging.
  const inspectorPanel=usePanelRef();const inspectorWidth=useRef(480);const [inspectorMotion,setInspectorMotion]=useState(false);const inspectorMoving=useRef(false);inspectorMoving.current=inspectorMotion;
  const [inspectorOpen, setInspectorOpen] = useStoredPreference(INSPECTOR_OPEN_KEY, decodeOpen, String);
  useEffect(() => { if (params.get('panel') === 'footage') setInspectorOpen(true); }, [params, setInspectorOpen]);
  useEffect(() => { const panel = inspectorPanel.current; if (panel && !compact && inspectorOpen === measured(() => panel.isCollapsed())) setInspectorMotion(true); }, [inspectorOpen, compact, inspectorPanel]);
  useEffect(() => {
    if (!inspectorMotion) return;
    // Resizing after the transition class has rendered lets the width change animate.
    const panel = inspectorPanel.current;
    if (panel && inspectorOpen === measured(() => panel.isCollapsed())) measured(() => { if (inspectorOpen) panel.resize(inspectorWidth.current); else panel.collapse(); });
    const done = setTimeout(() => setInspectorMotion(false), 400);
    return () => clearTimeout(done);
  }, [inspectorMotion, inspectorOpen, inspectorPanel]);
  const inspectorRequest = useRef(params.get('panel') === 'footage' ? 1 : 0);
  const [sourceRequest, setSourceRequest] = useState(inspectorRequest.current);
  const fileDrop = useMediaFileDrop({ busy: !!p.upload, onUpload: files => { setSourceRequest(++inspectorRequest.current); setInspectorOpen(true); return p.onDropUpload(files); }, onError });
  const editorRoot = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const chatPanel=usePanelRef();const [chatCollapsed,setChatCollapsed]=useState(false);
  const timelinePanel=usePanelRef();const timelineInitialized=useRef(false);const expandedTimelineHeight=useRef<number|null>(null);const collapsed=useEditorState(s=>s.timelineCollapsed);
  const toggleTimeline=()=>{
    const panel=timelinePanel.current;if(!panel)return;
    if(collapsed){if(expandedTimelineHeight.current!==null)panel.resize(expandedTimelineHeight.current);else panel.resize(360);}
    else{expandedTimelineHeight.current=panel.getSize().inPixels;panel.collapse();}
    store.setState({timelineCollapsed:!collapsed});
  };
  const [collapsedTimelineHeight,setCollapsedTimelineHeight]=useState(36);
  // No fixed pixel threshold separates the states: the collapsed toolbar wraps to ~121px on phones, a
  // collapsed panel drifts while its group resizes, and short viewports squeeze an expanded panel below
  // minSize. So keep the current state in between: collapse only on reaching the measured toolbar height,
  // expand only on reaching the effective minimum, min(minSize, maxSize). The toggle sets the state itself.
  const collapsedHeightRef=useRef(collapsedTimelineHeight);collapsedHeightRef.current=collapsedTimelineHeight;
  const timelineCollapsedAt=(size:{inPixels:number;asPercentage:number})=>{
    if(!store.getState().timelineCollapsed)return size.inPixels<=collapsedHeightRef.current+1;
    const group=size.asPercentage>0?size.inPixels*100/size.asPercentage:Infinity;
    return size.inPixels<Math.min(TIMELINE_MIN_HEIGHT,group*TIMELINE_MAX_SHARE)-1;
  };
  const workspace = useRef({ projectId: p.projectId, opened: false });
  const [promptStart, setPromptStart] = useState<string | null>(null);
  if (workspace.current.projectId !== p.projectId) workspace.current = { projectId: p.projectId, opened: false };
  if (!p.upload && (timeline.clips.length || assets.length || p.canUndo || p.aiRunning || promptStart === p.projectId || p.conversation)) workspace.current.opened = true;
  // Empty edits are still projects: keep the conversation, stop button and timeline mounted.
  const pendingImport=p.videoImports?.some(task=>!['failed','completed','cancelled'].includes(task.status));
  const preparing = !p.assistantPanel && !p.aiRunning && (!workspace.current.opened || !timeline.clips.length&&!!pendingImport);
  // Desktop has one layout: chat on the left, each side minimizable. Phones switch between the two.
  const mode = compact ? mobileConversation ? 'agentic' : 'tracks' : 'agentic';
  const conversationVisible = compact ? mobileChat : true;
  useLayoutEffect(() => {
    if (compact || !conversationVisible) {
      chatPanel.current?.collapse();
      // On first load the panel registers as collapsible after this runs; collapse again once it has.
      const retry = requestAnimationFrame(() => chatPanel.current?.collapse());
      return () => cancelAnimationFrame(retry);
    }
    const panel = chatPanel.current;
    panel?.expand();
    // A chat first opened at width 0 (MCP mode) expands to its minimum; give it the usual width.
    if (panel && panel.getSize().inPixels < 310) panel.resize(400);
  }, [compact, conversationVisible, preparing, chatPanel]);
  // While an outside agent edits over MCP, the chat stays closed if the user closed it last time.
  const mcpChatReady=useRef(false);
  useLayoutEffect(()=>{
    mcpChatReady.current=false;
    if(!p.externalAgent||compact)return;
    if(readStoredPreference(MCP_CHAT_CLOSED_KEY)==='1'){chatPanel.current?.collapse();}
    const settle=requestAnimationFrame(()=>{if(readStoredPreference(MCP_CHAT_CLOSED_KEY)==='1')chatPanel.current?.collapse();requestAnimationFrame(()=>{mcpChatReady.current=true;});});
    return ()=>cancelAnimationFrame(settle);
  },[p.externalAgent,compact,conversationVisible,preparing,chatPanel]);
  useEffect(()=>{
    if(!p.externalAgent||compact||!mcpChatReady.current)return;
    writeStoredPreference(MCP_CHAT_CLOSED_KEY,chatCollapsed?'1':null);
  },[chatCollapsed,p.externalAgent,compact]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => body.style.setProperty('--editor-body-height', `${body.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    measure(); observer.observe(body);
    return () => observer.disconnect();
  }, [preparing]);
  useLayoutEffect(() => {
    const toolbar=bodyRef.current?.querySelector<HTMLElement>('.timeline-toolbar');
    if(!toolbar)return;
    // Collapsed, the timeline still shows its tab row above the toolbar; keep both on screen so the
    // expand button stays reachable.
    const tabs=()=>toolbar.parentElement?.querySelector<HTMLElement>('.timeline-tabs')??null;
    const measure=()=>{const row=tabs(),bottom=toolbar.getBoundingClientRect().bottom,top=row?Math.min(row.getBoundingClientRect().top,toolbar.getBoundingClientRect().top):toolbar.getBoundingClientRect().top;setCollapsedTimelineHeight(Math.max(1,Math.ceil(bottom-top)));};
    const observer=new ResizeObserver(measure);
    measure();observer.observe(toolbar);const row=tabs();if(row)observer.observe(row);
    return()=>observer.disconnect();
  },[preparing]);
  useEffect(()=>{
    if(preparing||timelineInitialized.current)return;
    const frame=requestAnimationFrame(()=>{
      if(!timelinePanel.current)return;
      timelineInitialized.current=true;
      timelinePanel.current.collapse();
      store.setState({timelineCollapsed:true});
    });
    return()=>cancelAnimationFrame(frame);
  },[preparing,timelinePanel,store]);
  useLayoutEffect(()=>{
    const panel=timelinePanel.current;
    // Keep a collapsed panel fitted when its toolbar wraps to another row.
    if(collapsed&&!preparing&&panel&&Math.abs((measured(()=>panel.getSize().inPixels)??collapsedTimelineHeight)-collapsedTimelineHeight)>.5){
      // A collapsed panel re-collapses so the library applies its newly registered collapsed size;
      // resizing below minSize before that registration lands snaps the panel open instead.
      measured(()=>{if(panel.isCollapsed())panel.collapse();else panel.resize(collapsedTimelineHeight);});
    }
  },[collapsed,collapsedTimelineHeight,preparing,timelinePanel]);
  const modeSwitch = !preparing && compact ? <SegmentedTabs label="Editor mode" className="editor-mode-switch" value={mode} onChange={value => setMobileChat(value === 'agentic')} options={[
    { value: 'agentic', label: 'Agentic', id: 'editor-agentic-tab', panelId: 'editor-mode-view', icon: <MessageSquare size={13}/> },
    { value: 'tracks', label: 'Tracks', id: 'editor-tracks-tab', panelId: 'editor-mode-view', icon: <Film size={13}/> },
  ]}/> : null;
  const [playbackReady,setPlaybackReady]=useState(!timeline.clips.length);
  const [loadingThumbnail,setLoadingThumbnail]=useState<string|null>(null);
  const [playbackError,setPlaybackError]=useState('');
  const [playbackSlow,setPlaybackSlow]=useState(false);
  const onSlowLoad=useCallback(()=>setPlaybackSlow(true),[]);
  const [thumbnailsReady,setThumbnailsReady]=useState(false);
  const [thumbnailsTimedOut,setThumbnailsTimedOut]=useState(false);
  const [openingAttempt,setOpeningAttempt]=useState(0);
  const [thumbnailProgress,setThumbnailProgress]=useState({ready:0,total:0});
  const referenceMedia=useCallback((assetId:string)=>assets.find(asset=>asset._id===assetId),[assets]);
  const firstVisualAsset=assets.find(asset=>asset._id===timeline.clips.find(clip=>clip.kind==='video'||clip.kind==='image')?.assetId);
  const onLoadingThumbnail=useCallback((url:string)=>{setLoadingThumbnail(url);if(firstVisualAsset&&!firstVisualAsset.thumbnailUrl)p.onSaveThumbnail?.(firstVisualAsset._id,url);},[firstVisualAsset,p.onSaveThumbnail]);
  const onPlaybackReady=useCallback(()=>{setPlaybackReady(true);setPlaybackError('');setPlaybackSlow(false);releaseOpeningFootage(p.projectId);if(preview.current)p.onPreviewReady?.(preview.current);},[p.projectId,p.onPreviewReady]);
  const audioPrepared=editorAudioPrepared(timeline,assets);
  const hasVisual=timeline.clips.some(clip=>clip.kind==='video'||clip.kind==='image');
  const openedOnce=useRef(false);
  const initialAnalysis=!openedOnce.current?p.preparationActivity:undefined;
  const opening=!openedOnce.current&&!p.demo&&!preparing&&timeline.clips.length>0&&(!playbackReady||!audioPrepared||!!initialAnalysis||(hasVisual&&!thumbnailsReady&&!thumbnailsTimedOut));
  const footageProgress=useFootageProgress(p.projectId?`project:${p.projectId}`:undefined,Math.min(99,(p.footageProgress??0)+(!preparing&&timeline.clips.length?(playbackReady?4:0)+(thumbnailsReady||thumbnailsTimedOut?6:thumbnailProgress.total?6*thumbnailProgress.ready/thumbnailProgress.total:0):0)));
  useEffect(()=>{
    if(!opening||!playbackReady||!audioPrepared||initialAnalysis||thumbnailsReady)return;
    // Stills improve navigation, but a blocked decoder must not lock a playable edit.
    const timer=setTimeout(()=>setThumbnailsTimedOut(true),MAX_THUMBNAIL_OPENING_WAIT_MS);
    return()=>clearTimeout(timer);
  },[opening,playbackReady,audioPrepared,initialAnalysis,thumbnailsReady,openingAttempt]);
  useEffect(()=>{
    if(preparing||opening)return;
    if(timeline.clips.length>0){openedOnce.current=true;if(p.projectId)rememberFootageProgress(`project:${p.projectId}`,100);}
    p.onOpened?.();
  },[preparing,opening,timeline.clips.length,p.onOpened]);
  const openingLog=useRef<{phase:string;started:number}|null>(null);
  useEffect(()=>{
    if(p.demo)return;
    const previous=openingLog.current;
    if(opening){const phase=p.preparationActivity||(!audioPrepared?'Preparing audio':!playbackReady?'Loading playback':'Loading timeline thumbnails');if(previous?.phase!==phase){const started=previous?.started??Date.now();openingLog.current={phase,started};console.info(`[import] ${new Date().toISOString()} ${phase}; editor opening ${((Date.now()-started)/1000).toFixed(1)}s.`);}}
    else if(previous){console.info(`[import] ${new Date().toISOString()} Editor ready with playback, audio and thumbnails; opening took ${((Date.now()-previous.started)/1000).toFixed(1)}s.`);openingLog.current=null;}
  },[opening,audioPrepared,playbackReady,p.demo,p.preparationActivity]);
  useEffect(()=>{
    if(!opening||!editorRoot.current)return;
    const root=editorRoot.current;
    const check=()=>setThumbnailsReady(timelineThumbnailsPrepared(root,(ready,total)=>setThumbnailProgress(previous=>previous.ready===ready&&previous.total===total?previous:{ready,total})));
    const observer=new MutationObserver(check);
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['src','data-thumbnail-exact','data-thumbnail-state']});
    const resize=new ResizeObserver(check);resize.observe(root);
    const rail=root.querySelector('.timeline-scroll');if(rail)resize.observe(rail);
    root.addEventListener('scroll',check,true);
    root.addEventListener('load',check,true);check();
    return()=>{observer.disconnect();resize.disconnect();root.removeEventListener('scroll',check,true);root.removeEventListener('load',check,true);};
  },[opening,openingAttempt,initialAnalysis,playbackReady,audioPrepared]);
  const previewError=useCallback((message:string)=>{if(!playbackReady)setPlaybackError(message);onError(message);},[playbackReady,onError]);
  const preview = useRef<PreviewHandle>(null);
  const readPlaybackTime=useCallback(()=>preview.current?.currentTime()??store.getState().playhead,[store]);
  // A film still being drafted can be scrubbed and played like the saved timeline.
  const duration = timelineDuration(previewTimeline);
  const clip = timeline.clips.find(c => c.id === selected);
  const suggestionAsset = clip?.kind === 'video'
    ? assets.find(asset => asset._id === clip.assetId)
    : assets.find(asset => asset.kind === 'video' && asset.analysis?.understanding?.suggestions?.length && timeline.clips.some(item => item.kind === 'video' && item.assetId === asset._id));
  const suggestionClip = suggestionAsset ? (clip?.kind === 'video' && clip.assetId === suggestionAsset._id ? clip : timeline.clips.find(item => item.kind === 'video' && item.assetId === suggestionAsset._id)) : undefined;
  const sourceSuggestions = suggestionAsset && suggestionClip && suggestionAsset.analysis?.understanding?.suggestions?.length ? { sourceName: suggestionAsset.fileName, clipId: suggestionClip.id, items: suggestionAsset.analysis.understanding.suggestions } : undefined;
  const cropping = !!clip && clip.id === croppingClip;
  useEffect(() => { if (croppingClip && (!clip || clip.id !== croppingClip)) setCroppingClip(null); }, [clip?.id, croppingClip]);
  // Moving the playhead never edits the timeline, so it stays free while the AI edits.
  const seek = useCallback((n: number) => {
    const t = frameSeekTime(n, timeline.fps, duration);
    setCroppingClip(null); setTime(t); preview.current?.seek(t);
  }, [duration, timeline.fps, setTime]);
  const changeAspectRatio = (aspectRatio: AspectRatio) => {
    if (editLock.current) return;
    preview.current?.pause();
    setCroppingClip(null);
    onChange({ ...timeline, aspectRatio });
  };

  const togglePlay = useCallback(() => {
    if (cropping) return;
    if (playing) preview.current?.pause();
    else { if (readPlaybackTime() >= duration) seek(0); preview.current?.play(); }
  }, [cropping, playing, readPlaybackTime, duration, seek]);
  // Each timeline keeps its own playhead: switching tabs pauses and resumes the next tab where it was left (0 the first time).
  const tabTimes = useRef(new Map<string, number>()), shownTab = useRef(activeTabId);
  useEffect(() => {
    const previous = shownTab.current;
    if (previous === activeTabId) return;
    if (previous) tabTimes.current.set(previous, readPlaybackTime());
    shownTab.current = activeTabId;
    preview.current?.pause();
    seek(activeTabId ? tabTimes.current.get(activeTabId) ?? 0 : 0);
  }, [activeTabId, readPlaybackTime, seek]);
  const doDelete = useCallback(() => {
    if (editLock.current) return;
    const ids=new Set(linkedClipIds(timeline,selectedIds.length?selectedIds:selected?[selected]:[]));
    if(!ids.size)return;onChange({...timeline,clips:timeline.clips.filter(c=>!ids.has(c.id))});setSelected(null);setCroppingClip(null);
  }, [selected, selectedIds, timeline, onChange]);
  const addMarker = useCallback(() => {
    if (editLock.current) return;
    const current = store.getState();
    const next = addTimelineMarker(timeline, current.playing ? readPlaybackTime() : current.playhead, crypto.randomUUID());
    if (next !== timeline) onChange(next);
  }, [timeline, onChange, readPlaybackTime, store]);
  const doCopy = useCallback(() => {
    const clips = copyTimelineClips(timeline, selectedIds.length ? selectedIds : selected ? [selected] : []);
    if (clips.length) setClipboard(clips);
  }, [timeline, selectedIds, selected]);
  const pasteCopies = useCallback((clips: Clip[], at: number, visualTrack?: number) => {
    if (editLock.current) return;
    try {
      const pasted = pasteTimelineClips(timeline, clips, at, undefined, { visualTrack });
      if (!pasted.ids.length) return;
      onChange(pasted.timeline);
      store.setState({ selectedId: pasted.ids[0], selectedIds: pasted.ids });
    } catch (error) { onError(userError(error, 'Could not paste these clips.')); }
  }, [timeline, onChange, onError, store]);
  const doPaste = useCallback((at?: number, visualTrack?: number) => pasteCopies(clipboard, at ?? readPlaybackTime(), visualTrack), [clipboard, pasteCopies, readPlaybackTime]);
  const doDuplicate = () => {
    const originals = copyTimelineClips(timeline, selectedIds.length ? selectedIds : selected ? [selected] : []);
    if (originals.length) pasteCopies(originals, Math.max(...originals.map(clip => clip.start + clip.duration)));
  };

  const keyboardHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keyboardHandler.current = (e: KeyboardEvent) => {
      if (!(e.target instanceof HTMLElement) || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const target = e.target;
      // The native player's controls sit in its shadow root, so events arrive retargeted to the
      // player itself. Judge the control that actually has focus: its buttons keep editor shortcuts.
      const path = e.composedPath()[0], focused = path instanceof HTMLElement ? path : target;
      const within = (selector: string) => !!target.closest(selector) || !!focused.closest(selector);
      if (target.isContentEditable || focused.isContentEditable || within('input,textarea,select,[role="slider"],[role="menu"]')) return;
      if (cropping) { if (e.key === 'Escape') setCroppingClip(null); if (e.code === 'Space' && !within('button,a,[role="button"]')) e.preventDefault(); return; }
      const dialog = target.closest('[role="dialog"]');
      if (dialog && dialog !== editorRoot.current?.closest('[role="dialog"]')) return;
      // Let focused controls keep their native Space activation. Clips handle
      // Space locally, so selecting one never toggles preview playback.
      if (e.code === 'Space' && within('button,a,[role="button"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"]')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (['<','>',',','.'].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        preview.current?.pause(); setPlaying(false);
        const direction = e.key === '<' || e.key === ',' ? -1 : 1;
        seek(frameSeekTime(readPlaybackTime(), timeline.fps, duration) + direction / timeline.fps);
      }
      else if (e.key.toLowerCase() === 'b' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (!editLock.current) store.setState({ tool: 'blade' }); }
      else if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); store.setState({ tool: 'select' }); }
      else if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (!e.repeat) addMarker(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); if(editLock.current)return; store.setState({selectedIds:timeline.clips.map(c=>c.id),selectedId:selected??timeline.clips[0]?.id??null}); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && (selectedIds.length || selected)) { e.preventDefault(); doCopy(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x' && (selectedIds.length || selected)) { e.preventDefault(); if (editLock.current) return; doCopy(); doDelete(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard.length) { e.preventDefault(); doPaste(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (e.key === 'Escape') { if (store.getState().tool === 'blade') { store.setState({ tool: 'select' }); return; } if(editLock.current)return; setSelected(null); if (compact) setMobileChat(false); }
    }
  });
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => keyboardHandler.current(event);
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);

  function addAsset(asset: MediaAsset) {
    if (editLock.current) return;
    try { const id = crypto.randomUUID(); onChange(addMediaClip(timeline, asset, id)); setSelected(id); }
    catch (error) { onError(userError(error, 'Could not add this source.')); }
  }
  async function addStockAudio(catalogId: string, at: number, track = 1) {
    if (editLock.current) return;
    if (!p.onRegisterStockAudio) throw new Error('Audio FX is unavailable in this editor.');
    const projectId = p.projectId, asset = await p.onRegisterStockAudio(catalogId);
    if (workspace.current.projectId !== projectId || editLock.current) return;
    const id = crypto.randomUUID();
    onChange(addMediaClip(store.getState().timeline, asset, id, at, track));setSelected(id);
  }
  function editText(id: string) {
    const item = timeline.clips.find(c => c.id === id);
    if (item?.kind === 'caption' || item?.kind === 'graphic') setSelected(id);
  }
  function selectClip(id:string|null){
    if (id !== selected) setCroppingClip(null);
    setSelected(id);
  }
  function addText(kind: 'caption' | 'graphic', options: { look?: TextLookId } = {}) {
    if (editLock.current) return;
    try {
      const id = crypto.randomUUID();
      let next = addTextClip(timeline, id, kind, readPlaybackTime());
      if (options.look) next = patchClip(next, id, textLookPatch(next.clips.find(item => item.id === id)!, options.look));
      onChange(next); setSelected(id);
    } catch (error) { onError(userError(error, 'Could not add this text.')); }
  }
  const browse = () => { setImportDestination('timeline');setImportOpen(true); };
  const browseSources=()=>{setImportDestination('sources');setImportOpen(true);};
  const browseComposer=()=>{setImportDestination('composer');setImportOpen(true);};

  const inspector = <PreviewInspector onRemoveAsset={p.onRemoveAsset} onAttachAsset={p.onAttachAsset&&(asset=>p.onAttachAsset!(asset._id))} usedAssetIds={usedAssetIds} sourceRequest={sourceRequest} videoImports={p.videoImports} assets={assets} upload={p.upload} onUpload={browseSources} onAdd={addAsset}/>;

  // On desktop the ratio chip sits on the preview frame's top-left corner, as in the design.
  const ratioOnFrame = !compact && !!previewTimeline.clips.length;
  const ratioControl = <AspectRatioControl value={timeline.aspectRatio} onChange={changeAspectRatio} safeArea={safeArea} onSafeAreaChange={changeSafeArea} />;
  const chat=(<aside className={`editor-sidebar ${mobileChat ? 'mobile-open' : ''}`} aria-label="Editing conversation" hidden={!conversationVisible}>
        {p.assistantPanel ?? <AssistantPanel referenceMedia={referenceMedia} upgrade={p.assistantUpgrade} externalAgent={p.externalAgent} attachments={p.composerAttachments} composerBusy={p.composerBusy} onRemoveAttachment={p.onRemoveComposerAttachment} conversation={p.conversation} editSnapshot={p.assistantEditSnapshot} canResumeEdit={p.canResumeEdit} messages={p.messages} running={p.aiRunning} editing={aiWorking} configured={p.aiConfigured} settings={p.assistantSettings} error={p.aiError} onSend={(text, modelChoice, reasoningEffort, speedMode) => p.onSend(text, { modelChoice, reasoningEffort, speedMode, selectedClipId: clip?.id, selectedClipIds:selectedIds, playhead: readPlaybackTime() })} onRetry={promptMessageId => p.onSend('', {playhead:readPlaybackTime(),retryPromptMessageId:promptMessageId})} onStop={p.onStop} hasClips={!!timeline.clips.length} demo={!!p.demo} onLoadMore={p.onLoadMore} canLoadMore={p.canLoadMore} onAttach={browseComposer} activity={p.analysisBusy} activitySource={p.analysisSource} activityProgress={p.analysisProgress} activityStartedAt={p.analysisStartedAt} budgetUsed={p.assistantBudgetUsed} draftKey={p.draftKey} suggestions={sourceSuggestions} onSuggestion={async (text, clipId, modelChoice, reasoningEffort, speedMode) => { const target = timeline.clips.find(item => item.id === clipId && item.kind === 'video'); if (!target) throw new Error('This clip is no longer on the timeline.'); setSelected(clipId); await p.onSend(text, { modelChoice, reasoningEffort, speedMode, selectedClipId: clipId, selectedClipIds: [clipId], playhead: target.start }); }} />}
      </aside>);
  return <main ref={editorRoot} data-playback-opening={opening} tabIndex={-1} {...fileDrop.handlers} className="editor-app conversation-editor">
    <TextFontStyles/>
    <MediaFileDropOverlay active={fileDrop.active} busy={!!p.upload}/>
    <WorkspaceNav chatId={p.demo ? undefined : p.projectId} title={p.title} onRename={p.onTitle} onShare={p.onShare} shareDisabled={!timeline.clips.length || editing} onExport={() => {setExportClipId(null);setExportOpen(true);}} exportDisabled={!timeline.clips.length} exportHint={!timeline.clips.length?'Add a clip to export':duration>MAX_EXPORT_SECONDS?`Exports support up to ${MAX_EXPORT_LABEL}. Shorten the edit to export.`:`Export an MP4 up to ${MAX_EXPORT_LABEL} long`} saving={p.saving} saveFailed={p.saveFailed} onRetrySave={p.onRetrySave} demo={p.demo} editorControls={compact ? undefined : modeSwitch}/>

    <EditorErrorNotice message={p.error} onDismiss={dismissError} />
    {!preparing&&<>{compact && <div className="mobile-panel-controls">{modeSwitch || <button aria-expanded={mobileChat} onClick={() => setMobileChat(!mobileChat)}><MessageSquare size={14} />{mobileChat ? 'Back to preview' : 'Open conversation'}</button>}<button onClick={() => { setSourceRequest(++inspectorRequest.current); setInspectorOpen(true); }}><Film size={14} />My media</button></div>}
    <section ref={bodyRef} id="editor-mode-view" data-mode={mode} data-chat-collapsed={!compact && chatCollapsed || undefined} className="editor-body" role={modeSwitch ? "tabpanel" : undefined} aria-labelledby={modeSwitch ? `editor-${mode}-tab` : undefined} aria-hidden={opening} inert={opening}><ResizablePanelGroup orientation="vertical" className="editor-canvas-panels"><ResizablePanel id="preview" className="editor-preview-row" defaultSize="70%" minSize={180}><ResizablePanelGroup orientation="horizontal" className="editor-horizontal-panels">
      {/* Dragging keeps the chat between 300 and 600px; only phone layouts collapse it. */}
      <ResizablePanel id="chat" className="editor-chat-panel" onResize={size => { bodyRef.current?.style.setProperty('--editor-chat-width', `${size.inPixels}px`); bodyRef.current?.style.setProperty('--editor-chat-divider', size.inPixels ? '1px' : '0px'); setChatCollapsed(size.inPixels === 0); }} panelRef={chatPanel} collapsible collapsedSize={0} defaultSize={400} minSize={300} maxSize={600}>{chat}</ResizablePanel>
      <ResizableHandle aria-label="Resize conversation" className="chat-resize-handle" disabled={compact || !conversationVisible} style={compact || !conversationVisible ? {display:"none"} : undefined}/>

      <ResizablePanel id="workspace" minSize={compact?0:320}><div className="editor-workspace">
        <ResizablePanelGroup orientation="horizontal" className="preview-layout" data-inspector-motion={inspectorMotion || undefined}><ResizablePanel id="canvas" minSize={220}><PreviewZoomProvider canvas={dimensions(timeline.aspectRatio)}><div className="preview-workspace"><CanvasSettings onShowChat={!compact && chatCollapsed ? () => chatPanel.current?.expand() : undefined} onHideChat={!compact && !chatCollapsed ? () => { flushSync(() => setChatCollapsed(true)); chatPanel.current?.collapse(); } : undefined}>{!ratioOnFrame && ratioControl}</CanvasSettings>
        <div className="editor-stage">

          <div className="preview-player"><div className="stage-center" data-ratio-on-frame={ratioOnFrame || undefined} style={{'--preview-ratio': dimensions(timeline.aspectRatio).width / dimensions(timeline.aspectRatio).height} as React.CSSProperties}>{previewTimeline.clips.length ? <><PreviewViewport><Preview controls={collapsed} safeArea={safeArea} onPlaybackAssets={onPlaybackAssets} onSlowLoad={onSlowLoad} onReady={onPlaybackReady} onThumbnail={onLoadingThumbnail} debugId={p.projectId} ref={preview} timeline={previewTimeline} assets={assets} time={time} onTime={setTime} onPlaying={setPlaying} onError={previewError} onRefreshMedia={p.onRefreshMedia} muted={muted} onMutedChange={setMuted} selectedClip={editing ? undefined : clip} cropping={cropping && !editing} onCropCancel={() => setCroppingClip(null)} onCropCommit={(id,crop) => { if (id === croppingClip && id === selected) { changeClip(id,{crop}); setCroppingClip(null); } }} onSelectClip={selectClip} onEditClip={selectClip} onEditText={editText} onClipChange={changeClip} onVisualChange={patch=>{if(clip)changeClip(clip.id,patch);}} /></PreviewViewport><PreviewFrameOverlay above={ratioOnFrame ? ratioControl : undefined}/></> : editing ? <div className="empty-canvas" role="status" aria-live="polite"><div className="scene-placeholder" style={{'--scene-hue': 222} as React.CSSProperties}><i/></div><div className="empty-canvas-copy"><h2>Building your film</h2><p>Each scene appears here as Revline makes it.</p></div></div> : <div className="empty-drop"><div className="empty-drop-copy"><h2>Start with a clip or an idea</h2><Button type="button" className="empty-drop-add" onClick={e => { e.stopPropagation(); browse(); }} disabled={!!p.upload}>{p.upload ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14}/>}Add footage</Button><p>Drop files anywhere in the editor</p>{p.upload && <Progress aria-label="Footage preparation progress" max={100} value={p.upload.percent} />}</div></div>}</div>{cropping ? <div className="preview-playback source-crop-actions" role="group" aria-label="Crop controls"><span className="source-crop-label">Crop</span><Button type="button" variant="ghost" size="sm" onClick={() => preview.current?.resetCrop()}><RotateCcw size={12}/>Reset</Button><Button type="button" variant="ghost" size="sm" onClick={() => { preview.current?.finishCrop(true); setCroppingClip(null); }}>Cancel</Button><Button type="button" size="sm" onClick={() => preview.current?.finishCrop()}>Done</Button></div> : null}</div>

        </div></div></PreviewZoomProvider></ResizablePanel>{!compact && <><ResizableHandle aria-label="Resize media panel" className="inspector-resize-handle" disabled={!inspectorOpen} style={inspectorOpen ? undefined : {display:'none'}}/><ResizablePanel id="inspector" className="inspector-panel" panelRef={inspectorPanel} collapsible collapsedSize={0} defaultSize={inspectorOpen ? 480 : 0} minSize={320} maxSize={680} onResize={size => { bodyRef.current?.style.setProperty('--editor-media-width', `${size.inPixels}px`); bodyRef.current?.style.setProperty('--editor-media-divider', size.inPixels ? '1px' : '0px'); if (inspectorMoving.current) return; const collapsed = measured(() => inspectorPanel.current?.isCollapsed()) ?? true; if (!collapsed && size.inPixels >= 320) inspectorWidth.current = size.inPixels; else if (collapsed && inspectorOpen) setInspectorOpen(false); }}><MediaTab open={inspectorOpen} onToggle={() => { if (inspectorOpen) { setInspectorOpen(false); return; } setSourceRequest(++inspectorRequest.current); setInspectorOpen(true); }}/>{(inspectorOpen || inspectorMotion) && inspector}</ResizablePanel></>}</ResizablePanelGroup>
        </div></ResizablePanel></ResizablePanelGroup></ResizablePanel><ResizableHandle aria-label="Resize preview and timeline" className="timeline-resize-handle"/><ResizablePanel id="timeline" panelRef={timelinePanel} collapsible collapsedSize={collapsedTimelineHeight} defaultSize={collapsedTimelineHeight} minSize={TIMELINE_MIN_HEIGHT} maxSize={`${TIMELINE_MAX_SHARE*100}%`} onResize={size=>{const isCollapsed=timelineCollapsedAt(size);if(!isCollapsed)expandedTimelineHeight.current=size.inPixels;store.setState({timelineCollapsed:isCollapsed});}}><div className="editor-timeline-content"><TimelinePanel ultra={p.ultra} sceneThumbs={p.sceneThumbs} sceneRendering={p.sceneRendering} onUndo={undo} onRedo={redo} canUndo={p.canUndo && !editing} canRedo={p.canRedo && !editing} key={openingAttempt} liveEdit={p.liveEdit} filmDraft={p.filmDraft} onExportClip={p.demo?undefined:id=>{setExportClipId(id);setExportOpen(true);}} tabs={p.timelineTabs} tabActions={p.timelineTabActions&&{...p.timelineTabActions,onExport:()=>{setExportClipId(null);setExportOpen(true);}}} aiWorking={aiWorking} workingAgent={p.externalAgent??null} workingLabel={p.externalAgent?`${p.externalAgent} is working`:'AI is working'} editingLocked={editing} onAddStockAudio={p.onRegisterStockAudio ? addStockAudio : undefined} playbackControls={collapsed?undefined:<div className="preview-playback" aria-label="Playback controls"><Button type="button" variant="ghost" size="icon-sm" aria-label={playing?'Pause':'Play'} disabled={!duration} onClick={togglePlay}>{playing?<Pause size={18} strokeWidth={1.5}/>:<Play size={18} strokeWidth={1.5}/>}</Button><PlaybackTime className="preview-time" time={time} duration={duration} fps={timeline.fps} playing={playing} readTime={readPlaybackTime}/></div>} onPreviewVolume={(id,volume)=>preview.current?.clipVolume(id,volume)} onTogglePlay={togglePlay} muted={muted} onToggleMute={()=>{setMuted(!muted);preview.current?.mute(!muted);}} collapsed={collapsed} onToggleCollapse={toggleTimeline} timeline={timeline} assets={timelineAssets} selected={selected} onSelect={selectClip} onEditText={editText} onEditClip={selectClip} time={time} playing={playing} readPlaybackTime={readPlaybackTime} onSeek={seek} onChange={onChange} onDelete={doDelete} onDuplicate={doDuplicate} onCopy={doCopy} onPaste={doPaste} canPaste={clipboard.length>0} onAddText={addText} onAddMarker={addMarker} onError={onError} />

        </div></ResizablePanel></ResizablePanelGroup>
    </section></>}
    {opening&&<FootagePreparation progressKey={p.projectId?`project:${p.projectId}`:undefined} progress={footageProgress} thumbnail={firstVisualAsset?.thumbnailUrl||(firstVisualAsset?.kind==='image'?firstVisualAsset.url:null)||openingFootage(p.projectId)?.thumbnail||loadingThumbnail} fileName={openingFootage(p.projectId)?.fileName} label={!playbackReady?'Loading footage…':!audioPrepared?'Preparing audio…':initialAnalysis||'Preparing timeline thumbnails…'} detail={playbackSlow&&!playbackReady?'Still loading the video. The editor will open when it is ready.':playbackReady&&audioPrepared&&!initialAnalysis&&thumbnailProgress.total?`${thumbnailProgress.ready} of ${thumbnailProgress.total} visible thumbnails loaded.`:undefined} error={playbackError} onRetry={()=>{setPlaybackError('');setPlaybackSlow(false);onError('');setOpeningAttempt(value=>value+1);preview.current?.retry();}}/>}
    {preparing&&<ProjectImportStage progressKey={p.projectId?`project:${p.projectId}`:undefined} importTask={p.videoImports?.find(task=>!['completed','cancelled'].includes(task.status))} upload={p.upload} onBrowse={browse} onUpload={p.onUpload} onStartFromPrompt={p.demo?undefined:()=>setPromptStart(p.projectId??null)}/>}
    {compact && inspectorOpen && <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}><SheetContent className="preview-inspector-sheet" showCloseButton={false}><div className="mobile-inspector-header"><SheetTitle>My media</SheetTitle><Button type="button" variant="ghost" size="icon" aria-label="Close editing panel" onClick={() => setInspectorOpen(false)}><X size={18}/></Button></div><SheetDescription>Add media to your timeline.</SheetDescription>{inspector}</SheetContent></Sheet>}
    <MediaImportDialog open={importOpen} onOpenChange={setImportOpen} onUpload={files=>{void (importDestination==='composer'?p.onAttachUpload??p.onDropUpload:editLock.current||importDestination==='sources'?p.onDropUpload:p.onUpload)(files);}} onImportVideo={editing?undefined:p.onImportVideo} disabled={!!p.upload} {...(importDestination==='composer'&&p.onAttachAsset?{projectMedia:assets.filter(asset=>asset.url&&!asset.preparation&&!assets.some(video=>video.audioAssetId===asset._id)&&!p.composerAttachments?.some(item=>item.id===asset._id)).sort((a,b)=>Number(a.kind==='audio')-Number(b.kind==='audio')),onPickProjectMedia:(asset:MediaAsset)=>p.onAttachAsset!(asset._id)}:{})}/>
    <ExportDialog ultra={p.ultra} open={exportOpen} onOpenChange={setExportOpen} title={exportClipId?`${p.title} clip`:!onlyOpenTab?`${p.title} · ${exportTabs.length} ${exportTabs.length===1?'video':'videos'}`:p.title} timeline={exportTimeline} clipOnly={!!exportClipId} coverUrl={exportCover} onExport={startExports} onCancel={p.onCancelExport} onDownload={p.onDownloadExport} state={exportState} demo={!!p.demo} videoCount={!onlyOpenTab?Math.max(1,exportTabs.length):1} timelines={multiTab?tabs.map(tab=>({id:tab.id,name:tab.name,aspectRatio:tab.active?timeline.aspectRatio:tab.aspectRatio,duration:tab.active?timelineDuration(timeline):tab.duration,cover:tab.active?exportCover:tab.cover})):[]} selectedTimelines={exportTabs} onSelectTimelines={setExportTabs} exports={(p.exports??[]).map(job=>({id:job.requestId!,status:job.status,progress:job.progress,label:job.label,createdAt:job.createdAt??0,resolution:job.resolution,sourceClipId:job.sourceClipId,aspectRatio:job.sourceTimelineId===activeTabId?timeline.aspectRatio:tabs.find(tab=>tab.id===job.sourceTimelineId)?.aspectRatio}))} />
  </main>;
}
