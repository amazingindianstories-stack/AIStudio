"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Upload, Users, Search, Plus, Pencil, Eye, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { capability } from "@/lib/model-registry";
import { thumbUrl } from "@/lib/utils";
import { portraitGroupVisible, portraitAttachAllowed, portraitReferenceUrl, portraitReadiness, portraitLibraryFull } from "@/lib/portrait-readiness";
import { askConfirm } from "@/lib/ask-text";
import { uploadFileDirect } from "@/lib/client-reference-upload";
import { setAssetDragData, getAssetDragData, validatePortraitDrop } from "@/lib/asset-drag-contract";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { PortraitLightbox } from "./PortraitLightbox";
import { ManagedPortraitGallery } from "./ManagedPortraitGallery";

const idOf = a => a.id || a.byteplusAssetId;
const button = "rounded-lg border border-line px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-40";
/** Managed (automatic) portraits when the backend has the pool on; the manual Gallery otherwise. */
export function PortraitGallery() {
  const open = useStore((state) => state.portraitGalleryOpen);
  const managed = useStore((state) => state.managedPortraits);
  const loadManaged = useStore((state) => state.loadManagedPortraits);
  useEffect(() => { if (open && managed.enabled === null) void loadManaged(); }, [open, managed.enabled, loadManaged]);
  // The manual Gallery stays mounted (it keeps its character filter across close/reopen).
  return <>
    {open && managed.enabled === true && <ManagedPortraitGallery />}
    <ManualPortraitGallery suppressed={managed.enabled !== false} />
  </>;
}

function ManualPortraitGallery({ suppressed = false }) {
  const s = useStore();
  const [groupId, setGroupId] = useState(null), [search, setSearch] = useState(""), [characters, setCharacters] = useState(""), [role, setRole] = useState("");
  const [selected, setSelected] = useState([]), [preview, setPreview] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [pendingDelete, setPendingDelete] = useState(null), [drag, setDrag] = useState(false);
  const [showUnavailable, setShowUnavailable] = useState(false), [groupDraft, setGroupDraft] = useState(""), [editingGroup, setEditingGroup] = useState(null);
  const confirmedGroupReset = useRef(false), previousSelectionScope = useRef(null);
  const anchor = useRef(null), input = useRef(null), dialog = useRef(null), depth = useRef(0);
  const assets = useMemo(()=>s.portraitAssets || [],[s.portraitAssets]), groups = useMemo(()=>s.portraitGroups || [],[s.portraitGroups]);
  const {portraitGalleryOpen,activeProjectId,loadAllPortraitAssets} = s;
  const library = portraitLibraryFull(assets, {fullAt: s.portraitQuotaFullAt, freedAt: s.portraitQuotaFreedAt});
  const unavailable = a => a.remoteVerification === "absent" || String(a.status || "").toLowerCase() === "remotemissing";
  const unavailableCount = assets.filter(unavailable).length;
  const visible = assets.filter(a => (showUnavailable || !unavailable(a)) && (groupId === null || (groupId === "unsorted" ? !a.groupId || /general|default|unsorted/i.test(groups.find(g=>g.id === a.groupId)?.name || "") : a.groupId === groupId)) && (!role || a.role === role) && (a.name || "").toLowerCase().includes(search.toLowerCase()));
  const chosen = visible.filter(a=>selected.includes(idOf(a)));
  const modelSlots = Math.max(0, capability(s.model,"maxReferenceImages",50) - (s.referenceKinds || []).filter(k=>k!=="video").length);
  useEffect(()=>{if(portraitGalleryOpen){void loadAllPortraitAssets(activeProjectId);setError("");}},[portraitGalleryOpen,activeProjectId,loadAllPortraitAssets]);
  // Focus the dialog once it actually renders: it stays hidden (suppressed) until the managed-portrait
  // status loads, so focusing on open alone would leave focus outside and Escape unhandled.
  useEffect(()=>{if(!portraitGalleryOpen||suppressed)return;const trigger=document.activeElement;dialog.current?.focus();return ()=>{if(trigger?.isConnected)trigger.focus?.();};},[portraitGalleryOpen,suppressed]);
  const processingPending = assets.some(a => String(a.status || "").toLowerCase() === "processing");
  useEffect(() => {
    if (!portraitGalleryOpen || !processingPending) return;
    const deadline = Date.now() + 120000;
    let inFlight = false, stopped = false;
    const timer = setInterval(async () => {
      if (stopped || Date.now() >= deadline) { clearInterval(timer); return; }
      const current = useStore.getState();
      if (!current.portraitGalleryOpen || current.portraitSyncError || !current.portraitAssets.some(a => String(a.status || "").toLowerCase() === "processing")) { clearInterval(timer); return; }
      if (document.hidden || inFlight || current.portraitAssetsLoading) return;
      inFlight = true;
      try { await current.loadAllPortraitAssets(activeProjectId); }
      finally { inFlight = false; }
    }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [portraitGalleryOpen, processingPending, activeProjectId]);
  const actorId = s.currentUser?.id || null;
  useEffect(() => {
    if (groupId && groupId !== "unsorted" && groups.some(g => g.id === groupId && !portraitGroupVisible(g))) {
      confirmedGroupReset.current = true;
      setGroupId(null);
    }
  }, [groupId, groups]);
  useEffect(()=>{setGroupId(null);setSearch("");setCharacters("");setRole("");setEditingGroup(null);setGroupDraft("");setPendingDelete(null);},[activeProjectId,actorId]);
  useEffect(()=>{
    const scope = {search,role,activeProjectId,actorId};
    const previous = previousSelectionScope.current;
    const sameScope = previous && Object.keys(scope).every(key => previous[key] === scope[key]);
    if (!(confirmedGroupReset.current && sameScope)) setSelected([]);
    confirmedGroupReset.current = false;
    previousSelectionScope.current = scope;
    anchor.current=null;setPreview(null);
  },[groupId,search,role,activeProjectId,actorId]);
  useEffect(()=>{setSelected(ids=>ids.filter(id=>assets.some(a=>idOf(a)===id && (showUnavailable || !unavailable(a)))));},[assets,showUnavailable]);
  if(!s.portraitGalleryOpen || suppressed) return null;
  const choose = (asset,e) => {
    const id=idOf(asset), end=visible.findIndex(a=>idOf(a)===id), start=visible.findIndex(a=>idOf(a)===anchor.current);
    if(e.shiftKey && start>=0) setSelected(visible.slice(Math.min(start,end),Math.max(start,end)+1).map(idOf));
    else setSelected(ids=>ids.includes(id)?ids.filter(x=>x!==id):[...ids,id]);
    if(!e.shiftKey) anchor.current=id;
  };
  const attach = () => {if(chosen.length>modelSlots){setError(`This model has room for ${modelSlots} portrait references. Pick the allowed subset or change model.`);return;}const result=s.attachPortraitsToComposer(chosen);if(!result?.ok)setError(result?.error || "Could not add portraits.");else {setError("");setSelected([]);}};
  const deleteSelected = async () => {
    if(busy) return;setBusy(true);let removed=0;const failed=[];const failureDetails=[];
    for(const a of pendingDelete || []) {try {const res=await s.deletePortraitAssetDirect(idOf(a));if(res?.ok)removed++;else {failed.push(a);failureDetails.push(res?.error || "Delete failed");}}catch(e){failed.push(a);failureDetails.push(e?.message || "Delete failed");}}
    setSelected(failed.map(idOf));setPreview(a=>a && !failed.some(f=>idOf(f)===idOf(a)) && (pendingDelete || []).some(d=>idOf(d)===idOf(a))?null:a);setPendingDelete(null);setBusy(false);setError(failed.length?`Deleted ${removed}; ${failed.length} failed. Failed portraits remain selected for retry. ${Array.from(new Set(failureDetails)).join("; ")}`:"");
  };
  const upload = async files => {
    if(!files || !files.length)return;
    if(library.full && !(await askConfirm({title:"Portrait library is full",description:"New portraits will be saved as images only and can't be used in videos until space is freed. Delete Ready portraits you no longer need first, then upload again.",confirmLabel:"Upload anyway"})))return;
    setBusy(true);setError("");let count=0;const failures=[], registrationWarnings=[];
    for(const file of Array.from(files || [])){try {const ready=await uploadFileDirect(file,"portrait");const result=await s.uploadPortraitImageDirect({referenceId:ready.referenceId,name:file.name.replace(/\.[^.]+$/,"") || "Portrait",role:"reference",groupId:groupId && groupId!=="unsorted"?groupId:undefined,projectId:s.activeProjectId || undefined});if(!result?.ok)throw new Error(result?.error || "Upload failed");count++;if(result.registrationError)registrationWarnings.push(`${file.name}: ${result.registrationError}`);}catch(e){failures.push(`${file.name}: ${e.message}`);}}
    setBusy(false);if(failures.length || registrationWarnings.length)setError([failures.length?`Uploaded ${count}; ${failures.join("; ")}`:"",...registrationWarnings].filter(Boolean).join("; "));
  };
  const drop = async e => {e.preventDefault();depth.current=0;setDrag(false);const validity=validatePortraitDrop(e,useStore.getState());if(!validity.valid){setError(validity.reason);return;}if(e.dataTransfer.files.length){void upload(e.dataTransfer.files);return;}const files=[];for(const a of getAssetDragData(e,useStore.getState()).items){try{const response=await fetch(a.url);if(!response.ok)throw new Error("Image unavailable");const blob=await response.blob();files.push(new File([blob],`${(a.prompt || "Portrait").slice(0,40)}.jpg`,{type:blob.type}));}catch(e){setError(e.message);}}if(files.length)void upload(files);};
  const saveGroup = async () => {if(!groupDraft.trim() || busy)return;setBusy(true);const result=editingGroup?await s.renamePortraitGroupDirect(editingGroup,groupDraft.trim()):await s.createPortraitGroup(groupDraft.trim(),"Virtual Portrait Character",s.activeProjectId);setBusy(false);if(result?.ok){setGroupDraft("");setEditingGroup(null);}else setError(result?.error || "Could not save character.");};
  const active = groups.find(g=>g.id===groupId);
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-3 backdrop-blur-sm" onClick={e=>{if(e.target===e.currentTarget)s.setPortraitGalleryOpen(false);}}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Portrait Gallery" className="flex h-[88dvh] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 text-white shadow-pop" onKeyDown={e=>{
      if(e.target.matches("input,textarea,select")&&e.key!=="Tab")return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="a"){e.preventDefault();setSelected(visible.map(idOf));}
      if(e.key==="Escape"){e.preventDefault();if(pendingDelete||preview)return;if(selected.length)setSelected([]);else s.setPortraitGalleryOpen(false);}
      if(e.key==="Tab"){const nodes=Array.from(dialog.current.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]'));const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    }}>
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3"><h2 className="text-sm font-semibold">Portrait Gallery <span className="text-white/50">/ {active?.name || (groupId==="unsorted"?"Unsorted":"All characters")}</span></h2><div className="flex items-center gap-2"><button className={button} disabled={s.portraitAssetsLoading} onClick={()=>{if(!useStore.getState().portraitAssetsLoading)void loadAllPortraitAssets(activeProjectId);}}>Refresh Gallery</button>{unavailableCount>0&&<button className={button} aria-pressed={showUnavailable} onClick={()=>setShowUnavailable(v=>!v)}>{showUnavailable?"Hide unavailable":"Show unavailable"} ({unavailableCount})</button>}<button className={button} aria-label="Close Portrait Gallery" onClick={()=>s.setPortraitGalleryOpen(false)}><X size={16}/></button></div></header>
      <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="flex shrink-0 flex-col border-b border-line p-3 sm:w-[220px] sm:border-b-0 sm:border-r"><label className="flex items-center gap-2 rounded-lg border border-line px-2"><Search size={14}/><input aria-label="Search characters" value={characters} onChange={e=>setCharacters(e.target.value)} placeholder="Search characters" className="min-w-0 w-full bg-transparent py-2 text-xs outline-none"/></label>
          <nav aria-label="Portrait characters" className="mt-2 flex shrink-0 gap-1 overflow-x-auto sm:max-h-none sm:flex-1 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto"><button className={button} aria-pressed={groupId==="unsorted"} onClick={()=>setGroupId("unsorted")}>Unsorted</button><button className={button} aria-pressed={groupId===null} onClick={()=>setGroupId(null)}>All characters</button>{groups.filter(portraitGroupVisible).filter(g=>g.name.toLowerCase().includes(characters.toLowerCase())).map(g=><div className="flex shrink-0 items-center sm:shrink" key={g.id}><button title={g.name} aria-pressed={g.id===groupId} className={`${button} min-w-0 flex-1 truncate text-left`} onClick={()=>setGroupId(g.id)}>{g.name}</button><button aria-label={`Rename ${g.name}`} className="p-2" onClick={()=>{setEditingGroup(g.id);setGroupDraft(g.name);}}><Pencil size={12}/></button></div>)}</nav>
          <form onSubmit={e=>{e.preventDefault();void saveGroup();}} className="mt-3 flex gap-1"><input aria-label={editingGroup?"Rename character":"New character name"} placeholder="New character" value={groupDraft} onChange={e=>setGroupDraft(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-transparent px-2 text-xs"/><button aria-label="Save character" disabled={busy||!groupDraft.trim()} className={button}><Plus size={14}/></button></form>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col" onDragEnter={e=>{e.preventDefault();depth.current++;setDrag(true);}} onDragLeave={()=>{depth.current=Math.max(0,depth.current-1);if(!depth.current)setDrag(false);}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect=validatePortraitDrop(e,useStore.getState()).valid?"copy":"none";}} onDrop={drop}>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line p-3">
            {chosen.length?<><span className="text-xs">{chosen.length} selected</span><button className={button} disabled={busy || chosen.some(a=>!portraitAttachAllowed(a))} onClick={attach}>Add {chosen.length} to prompt</button>{chosen.length>modelSlots&&<button className={button} disabled={busy||!modelSlots} onClick={()=>setSelected(chosen.slice(0,modelSlots).map(idOf))}>Pick first {modelSlots} allowed</button>}<button className={`${button} border-red-400/50 bg-red-500/15 text-red-200 hover:bg-red-500/25`} disabled={busy} onClick={()=>setPendingDelete(chosen)}><Trash2 size={14} className="mr-1 inline"/>Delete selected ({chosen.length})</button><button className={button} aria-label="More selection actions" onClick={()=>setPreview(chosen[0])}><MoreHorizontal size={15}/></button><button className={button} aria-label="Clear selection" onClick={()=>setSelected([])}><X size={14}/></button></>:<><button className={`${button} border-red-400/30 text-red-200`} disabled title="Select portraits to delete"><Trash2 size={14} className="mr-1 inline"/>Delete selected (0)</button><input aria-label="Search portraits" placeholder="Search portraits" value={search} onChange={e=>setSearch(e.target.value)} className="min-w-0 max-w-[360px] flex-1 rounded-lg border border-line bg-transparent px-3 py-2 text-xs"/><select aria-label="Filter portrait role" className="rounded-lg border border-line bg-ink-850 p-2 text-xs" value={role} onChange={e=>setRole(e.target.value)}><option value="">All roles</option>{Array.from(new Set(assets.map(a=>a.role || "reference"))).map(r=><option key={r}>{r}</option>)}</select><button disabled={busy} className={button} onClick={()=>input.current?.click()}><Upload size={14} className="mr-1 inline"/>Upload</button></>}
            <input ref={input} type="file" multiple accept="image/*" className="hidden" onChange={e=>{void upload(e.target.files);e.target.value="";}}/>
          </div>
          {library.full&&<div role="alert" data-portrait-library-full className="mx-3 mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"><p className="font-semibold">Portrait library is full</p><p className="mt-0.5 text-amber-100/80">New portraits can&apos;t be prepared for video until space is freed. Select Ready portraits you no longer need and delete them, then upload again. Deleting &quot;Image only&quot; portraits doesn&apos;t free space.</p></div>}
          {library.freedSince&&<p role="status" className="mx-3 mt-3 text-xs text-emerald-300">Space was freed — you can upload portraits again.</p>}
          {(error||s.portraitSyncError)&&<p role="alert" className="px-3 py-2 text-xs text-red-300">{error||s.portraitSyncError}</p>}
          {busy&&<p role="status" className="p-3 text-xs"><Loader2 className="inline animate-spin" size={14}/> Processing portraits…</p>}
          <div className={`min-h-0 flex-1 overflow-y-auto p-3 ${drag?"ring-2 ring-inset ring-brand":""}`}>
            {s.portraitAssetsLoading?<div role="status" className="grid grid-cols-2 gap-3 md:grid-cols-3">{Array.from({length:6},(_,i)=><div key={i} className="h-40 animate-pulse rounded-lg bg-white/5 motion-reduce:animate-none"/>)}<span className="sr-only">Loading portraits</span></div>:!visible.length?<p className="p-8 text-center text-sm text-white/50">No portraits here. Upload images to get started.</p>:<div aria-label="Portrait tiles" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{visible.map(a=><article key={idOf(a)} tabIndex={0} aria-label={a.name || "Portrait"} data-selected={selected.includes(idOf(a))} draggable={portraitAttachAllowed(a)} onDragStart={e=>{if((selected.includes(idOf(a))?chosen:[a]).some(p=>!portraitAttachAllowed(p))){e.preventDefault();setError("Portrait registration is not verified active.");return;}setAssetDragData(e.dataTransfer,(selected.includes(idOf(a))?chosen:[a]).map(p=>({...p,url:portraitReferenceUrl(p),kind:"image",prompt:p.name})),{...a,url:portraitReferenceUrl(a),kind:"image"});}} onClick={e=>choose(a,e)} onDoubleClick={()=>setPreview(a)} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key===" "){e.preventDefault();choose(a,{...e,ctrlKey:true});}if(e.key==="Enter"){e.preventDefault();setPreview(a);}if(["ArrowRight","ArrowLeft"].includes(e.key)){e.preventDefault();const next=visible[visible.findIndex(x=>idOf(x)===idOf(a))+(e.key==="ArrowRight"?1:-1)];if(next){const el=e.currentTarget.parentElement.children[visible.indexOf(next)];el.focus();if(e.shiftKey)choose(next,e);}}}} className={`group min-w-0 overflow-hidden rounded-lg border outline-none focus:ring-2 focus:ring-brand ${selected.includes(idOf(a))?"border-brand bg-brand/10":"border-line bg-ink-900"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={a.name || "Portrait"} src={thumbUrl(a.imageUrl)} className="h-[140px] w-full object-cover"/>
              <div className="p-2"><div className="flex items-center gap-1"><input type="checkbox" aria-label={`Select ${a.name || "portrait"}`} checked={selected.includes(idOf(a))} onClick={e=>e.stopPropagation()} onChange={()=>choose(a,{ctrlKey:true})}/><span title={a.name} className="min-w-0 flex-1 truncate text-xs">{a.name || "Portrait"}</span><button aria-label={`View ${a.name || "portrait"}`} className="p-1 opacity-70 hover:opacity-100" onClick={e=>{e.stopPropagation();setPreview(a);}}><Eye size={13}/></button></div><div title={portraitReadiness(a).detail} aria-label={`Portrait registration: ${portraitReadiness(a).label}`} className="mt-1 truncate text-[10px] text-white/60">{portraitReadiness(a).label}</div><div className="mt-1 flex justify-between text-[10px] text-white/50"><span>{a.role || "reference"}</span><span title={a.uploader?.name || "Unknown uploader"} aria-label={`Uploader: ${a.uploader?.name || "Unknown uploader"}`}><Users size={11} className="mr-1 inline"/>{a.uploader?.name?.slice(0,2).toUpperCase() || "?"}</span></div></div>
            </article>)}</div>}
          </div>
        </main>
        {preview&&<PortraitLightbox embedded asset={preview} assets={visible} groupName={active?.name} onClose={()=>setPreview(null)} onSelectAsset={setPreview} onAttach={(a)=>{const result=s.attachPortraitsToComposer([a]);if(!result?.ok)setError(result?.error);}} onDelete={a=>setPendingDelete([a])} onRename={async(id,name)=>{const result=await s.renamePortraitAssetDirect(id,name);if(result?.ok)setPreview(a=>({...a,name}));return result;}}/>}
      </div>
    </section>
    <ConfirmActionDialog open={!!pendingDelete} title={`Delete ${pendingDelete?.length || 0} ${pendingDelete?.length === 1 ? "portrait" : "portraits"}?`} description={`${pendingDelete?.slice(0,6).map(a=>a.name || "Portrait").join(", ") || ""}${pendingDelete?.length>6?", …":""}. They will be removed from the gallery. Original files are kept.`} confirmLabel={`Delete ${pendingDelete?.length || 0}`} destructive busy={busy} onCancel={()=>setPendingDelete(null)} onConfirm={deleteSelected}/>
  </div>;
}
