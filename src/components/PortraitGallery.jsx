"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Upload,
  Trash2,
  Images,
  Sparkles,
  AlertCircle,
  Pencil,
  Check,
  Search,
  Loader2,
  Plus,
  FolderPlus,
  Users,
  RefreshCw,
  Eye,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { thumbUrl } from "@/lib/utils";
import { encodeBlobWithBudget } from "@/lib/client-image-budget";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useConfirmedAction } from "./useConfirmedAction";
import { PortraitLightbox } from "./PortraitLightbox";

export function PortraitGallery() {
  const open = useStore((s) => s.portraitGalleryOpen);
  const setOpen = useStore((s) => s.setPortraitGalleryOpen);
  const assets = useStore((s) => s.portraitAssets);
  const groups = useStore((s) => s.portraitGroups);
  const loading = useStore((s) => s.portraitAssetsLoading);
  const loadAll = useStore((s) => s.loadAllPortraitAssets);
  const uploadDirect = useStore((s) => s.uploadPortraitImageDirect);
  const deleteDirect = useStore((s) => s.deletePortraitAssetDirect);
  const renameDirect = useStore((s) => s.renamePortraitAssetDirect);
  const createGroup = useStore((s) => s.createPortraitGroup);
  const deleteGroup = useStore((s) => s.deletePortraitGroup);
  const renameGroup = useStore((s) => s.renamePortraitGroupDirect);
  const attachPortrait = useStore((s) => s.attachPortraitToComposer);

  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState(null);

  // Full-View Lightbox state
  const [selectedAssetForPreview, setSelectedAssetForPreview] = useState(null);

  // Creating new character group
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);

  // Renaming character group
  const [renamingGroupId, setRenamingGroupId] = useState(null);
  const [groupRenameInput, setGroupRenameInput] = useState("");

  // Visual feedback when attached to prompt
  const [lastAttachedId, setLastAttachedId] = useState(null);

  const confirmation = useConfirmedAction();

  // Load all assets when modal opens
  useEffect(() => {
    if (open) {
      loadAll();
      setError("");
      setSearch("");
      setSelectedAssetForPreview(null);
    }
  }, [open, loadAll]);

  // Global Escape key support
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (selectedAssetForPreview) {
          setSelectedAssetForPreview(null);
        } else if (editingId) {
          setEditingId(null);
        } else if (creatingGroup) {
          setCreatingGroup(false);
          setNewGroupName("");
        } else if (renamingGroupId) {
          setRenamingGroupId(null);
        } else {
          setOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, selectedAssetForPreview, editingId, creatingGroup, renamingGroupId, setOpen]);

  // Handle manual sync with BytePlus ModelArk
  const handleSync = async () => {
    setSyncing(true);
    setError("");
    try {
      await loadAll();
    } catch (err) {
      setError(err?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  // Handle image files selection/drop
  const handleFiles = useCallback(
    async (files) => {
      const imageFiles = Array.from(files || []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (imageFiles.length === 0) {
        setError("Please select valid image files (PNG, JPG, WebP).");
        return;
      }

      setUploading(true);
      setError("");
      setUploadCount(imageFiles.length);

      let successCount = 0;
      let lastError = "";

      const MAX_PORTRAIT_RAW_BYTES = 25 * 1024 * 1024; // 25 MB

      for (const file of imageFiles) {
        try {
          if (file.size > MAX_PORTRAIT_RAW_BYTES) {
            lastError = `"${file.name}" is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Max size is 25MB.`;
            continue;
          }

          // Use client budget ladder to resize to max 2048px and compress under 3MB
          // This keeps facial fidelity sharp while preventing Vercel HTTP 413 body ceiling crashes
          const dataUrl = await encodeBlobWithBudget(file);

          const baseName = file.name
            .replace(/\.[^/.]+$/, "")
            .replace(/[-_]+/g, " ")
            .trim();
          const cleanName =
            baseName.charAt(0).toUpperCase() + baseName.slice(1) || "Portrait";

          const res = await uploadDirect({
            dataUrl,
            name: cleanName,
            role: "reference",
            groupId: selectedGroupId || undefined,
          });

          if (res.ok) {
            successCount++;
          } else {
            lastError = res.error || "Upload failed";
          }
        } catch (err) {
          lastError = err?.message || "File processing error";
        }
      }

      setUploading(false);
      setUploadCount(0);

      if (successCount === 0 && lastError) {
        setError(lastError);
      } else if (lastError && successCount > 0) {
        setError(`Uploaded ${successCount} image(s), but some failed: ${lastError}`);
      }
    },
    [uploadDirect, selectedGroupId]
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const startRenamingAsset = (asset, e) => {
    e?.stopPropagation();
    setEditingId(asset.id || asset.byteplusAssetId);
    setEditName(asset.name || "");
  };

  const saveRenamingAsset = async (assetId) => {
    if (editName.trim()) {
      await renameDirect(assetId, editName.trim());
    }
    setEditingId(null);
  };

  const handleCreateGroup = async (e) => {
    e?.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    setSavingGroup(true);
    const res = await createGroup(name, "Virtual Portrait Character");
    setSavingGroup(false);
    if (res.ok && res.group) {
      setSelectedGroupId(res.group.id);
      setNewGroupName("");
      setCreatingGroup(false);
      await loadAll();
    } else {
      setError(res.error || "Failed to create character group");
    }
  };

  const startRenamingGroup = (group, e) => {
    e?.stopPropagation();
    setRenamingGroupId(group.id);
    setGroupRenameInput(group.name || "");
  };

  const saveRenamingGroup = async (groupId) => {
    if (groupRenameInput.trim()) {
      await renameGroup(groupId, groupRenameInput.trim());
    }
    setRenamingGroupId(null);
  };

  const handleDeleteGroup = (group, e) => {
    e?.stopPropagation();
    confirmation.ask("deletePortraitGroup", async () => {
      const res = await deleteGroup(group.id);
      if (res?.ok && selectedGroupId === group.id) {
        setSelectedGroupId(null);
      }
      return res;
    });
  };

  const handleAttachToPrompt = (asset, label) => {
    attachPortrait(asset, label);
    setLastAttachedId(asset.id || asset.byteplusAssetId);
    setTimeout(() => setLastAttachedId(null), 2500);
  };

  const activeGroup = groups.find((g) => g.id === selectedGroupId);

  const filteredAssets = assets
    .filter((a) => (!selectedGroupId ? true : a.groupId === selectedGroupId))
    .filter((a) => (a.name || "").toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] grid place-items-center p-3 sm:p-4"
          >
            {/* Overlay backdrop */}
            <div
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="relative flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-pop"
            >
              {/* Header */}
              <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand ring-1 ring-brand/30">
                    <Images className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-white">
                        Portrait Gallery
                      </h2>
                      <span className="rounded-md bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand ring-1 ring-brand/30">
                        Asset Library
                      </span>
                    </div>
                    <p className="text-[11px] text-white/55">
                      Character portrait personas synchronized with BytePlus ModelArk ({assets.length} portrait{assets.length === 1 ? "" : "s"} across {groups.length} character{groups.length === 1 ? "" : "s"})
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Refresh / Sync Button */}
                  <button
                    type="button"
                    onClick={handleSync}
                    disabled={syncing || loading}
                    title="Sync and refresh portrait statuses with BytePlus ModelArk"
                    className="flex items-center gap-1.5 rounded-lg border border-line/60 bg-ink-800 px-2.5 py-1.5 text-xs text-white/80 transition hover:border-brand/40 hover:bg-ink-750 hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${syncing || loading ? "animate-spin text-brand" : "text-white/60"}`} />
                    <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </header>

              {/* Main scrollable body */}
              <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-5">
                {/* Character Groups Selector Tabs */}
                <div className="mb-4 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedGroupId(null)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      selectedGroupId === null
                        ? "bg-white text-zinc-950 font-semibold shadow-sm"
                        : "bg-ink-800 text-white/70 hover:bg-ink-750 hover:text-white border border-line/60"
                    }`}
                  >
                    <Users className="h-3.5 w-3.5" />
                    <span>All Characters</span>
                    <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${selectedGroupId === null ? "bg-black/15 text-zinc-950 font-bold" : "bg-ink-700 text-white/50"}`}>
                      {assets.length}
                    </span>
                  </button>

                  {groups.map((group) => {
                    const count = assets.filter((a) => a.groupId === group.id).length;
                    const isSelected = selectedGroupId === group.id;
                    const isRenaming = renamingGroupId === group.id;

                    if (isRenaming) {
                      return (
                        <div key={group.id} className="flex items-center gap-1 rounded-lg border border-brand bg-ink-900 px-1 py-0.5">
                          <input
                            type="text"
                            value={groupRenameInput}
                            autoFocus
                            onChange={(e) => setGroupRenameInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveRenamingGroup(group.id);
                              if (e.key === "Escape") setRenamingGroupId(null);
                            }}
                            className="h-6 w-28 bg-transparent px-1.5 text-xs text-white focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => saveRenamingGroup(group.id)}
                            className="grid h-5 w-5 place-items-center rounded bg-white text-zinc-950 hover:bg-zinc-200"
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingGroupId(null)}
                            className="grid h-5 w-5 place-items-center rounded text-white/50 hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={group.id}
                        className={`group relative flex items-center rounded-lg border transition ${
                          isSelected
                            ? "border-white bg-white text-zinc-950 shadow-sm"
                            : "border-line/60 bg-ink-800 text-white/70 hover:bg-ink-750 hover:text-white"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedGroupId(group.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium"
                        >
                          <span className={isSelected ? "font-semibold text-zinc-950" : ""}>{group.name}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                              isSelected ? "bg-black/15 text-zinc-950 font-bold" : "bg-ink-700 text-white/50"
                            }`}
                          >
                            {count}
                          </span>
                        </button>

                        {/* Selected Group Action Controls (Rename & Delete) */}
                        {isSelected && (
                          <div className="flex items-center gap-0.5 pr-1.5 text-zinc-950/70">
                            <button
                              type="button"
                              onClick={(e) => startRenamingGroup(group, e)}
                              title="Rename character group"
                              className="grid h-5 w-5 place-items-center rounded hover:bg-black/10 hover:text-zinc-950 transition"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteGroup(group, e)}
                              title="Delete character group"
                              className="grid h-5 w-5 place-items-center rounded hover:bg-red-600 hover:text-white transition"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {creatingGroup ? (
                    <form onSubmit={handleCreateGroup} className="flex items-center gap-1 ml-1">
                      <input
                        type="text"
                        placeholder="Character name…"
                        value={newGroupName}
                        autoFocus
                        onChange={(e) => setNewGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setCreatingGroup(false);
                            setNewGroupName("");
                          }
                        }}
                        className="h-7 w-36 rounded-lg border border-brand bg-ink-900 px-2 text-xs text-white placeholder-white/40 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={savingGroup || !newGroupName.trim()}
                        className="grid h-7 w-7 place-items-center rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 disabled:opacity-50"
                      >
                        {savingGroup ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingGroup(false);
                          setNewGroupName("");
                        }}
                        className="grid h-7 w-7 place-items-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCreatingGroup(true)}
                      className="flex items-center gap-1 rounded-lg border border-dashed border-white/25 bg-ink-800/40 px-2.5 py-1.5 text-xs text-white/60 transition hover:border-brand/50 hover:text-brand hover:bg-brand/5"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      <span>New Character</span>
                    </button>
                  )}
                </div>

                {/* Dropzone / Upload area */}
                <div
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onClick={() => !uploading && fileInputRef.current?.click()}
                  className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition ${
                    dragOver
                      ? "border-brand bg-brand/10 shadow-lg"
                      : "border-white/15 bg-ink-800/60 hover:border-brand/50 hover:bg-ink-800"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        handleFiles(e.target.files);
                        e.target.value = "";
                      }
                    }}
                  />

                  {uploading ? (
                    <div className="flex flex-col items-center gap-2 text-brand">
                      <Loader2 className="h-8 w-8 animate-spin" />
                      <p className="text-sm font-semibold">
                        Uploading {uploadCount > 1 ? `${uploadCount} portraits` : "portrait"}…
                      </p>
                      <p className="text-xs text-white/50">
                        Validating image and registering asset in BytePlus ModelArk
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand group-hover:scale-105 transition">
                        <Upload className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          <span className="text-brand font-semibold">Click to upload</span> or drag and drop portrait images
                          {activeGroup ? (
                            <span className="text-white/70"> for <strong className="text-white">{activeGroup.name}</strong></span>
                          ) : ""}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-white/45">
                          <span className="rounded bg-white/5 px-1.5 py-0.5 border border-white/10">PNG</span>
                          <span className="rounded bg-white/5 px-1.5 py-0.5 border border-white/10">JPG</span>
                          <span className="rounded bg-white/5 px-1.5 py-0.5 border border-white/10">WebP</span>
                          <span>•</span>
                          <span>Up to 25MB (auto-compressed for crisp facial detail)</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Error banner */}
                {error && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-300">
                    <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                    <span className="flex-1">{error}</span>
                    <button
                      type="button"
                      onClick={() => setError("")}
                      className="text-white/60 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* Filter bar & stats */}
                {assets.length > 0 && (
                  <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="relative flex-1 max-w-xs">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
                      <input
                        type="text"
                        placeholder="Search portraits…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full rounded-xl border border-line bg-ink-800 py-1.5 pl-8 pr-7 text-xs text-white placeholder-white/40 focus:border-brand focus:outline-none"
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={() => setSearch("")}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white/50">
                      <span>
                        {filteredAssets.length} portrait{filteredAssets.length === 1 ? "" : "s"}
                        {activeGroup ? ` in ${activeGroup.name}` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1 font-medium text-brand hover:underline"
                      >
                        <Plus className="h-3.5 w-3.5" /> Add more
                      </button>
                    </div>
                  </div>
                )}

                {/* Assets Grid */}
                <div className="mt-4">
                  {loading && assets.length === 0 ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div
                          key={i}
                          className="skeleton aspect-[3/4] w-full rounded-xl border border-line"
                        />
                      ))}
                    </div>
                  ) : filteredAssets.length === 0 ? (
                    assets.length === 0 ? null : (
                      <div className="py-12 text-center text-xs text-white/40">
                        No portraits match current filter.
                      </div>
                    )
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                      {filteredAssets.map((asset) => {
                        const isAttached = lastAttachedId === (asset.id || asset.byteplusAssetId);
                        const isProcessing = asset.status === "Processing";
                        const isFailed = asset.status === "Failed";

                        return (
                          <div
                            key={asset.id || asset.byteplusAssetId}
                            onClick={() => setSelectedAssetForPreview(asset)}
                            className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-ink-800 transition hover:border-brand/50 hover:shadow-lg"
                          >
                            {/* Thumbnail image */}
                            <div className="relative aspect-[3/4] w-full overflow-hidden bg-ink-950/85 p-1 flex items-center justify-center">
                              {asset.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={thumbUrl(asset.imageUrl, 400)}
                                  alt={asset.name || "Portrait"}
                                  loading="lazy"
                                  className="h-full w-full object-contain transition duration-300 group-hover:scale-105"
                                />
                              ) : (
                                <div className="grid h-full w-full place-items-center text-white/20">
                                  <Images className="h-8 w-8" />
                                </div>
                              )}

                              {/* Status Badge */}
                              <div className="absolute left-2 top-2 flex items-center gap-1.5">
                                <span
                                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-md ${
                                    isProcessing
                                      ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/30"
                                      : isFailed
                                      ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/30"
                                      : "bg-ink-950/85 text-emerald-400 ring-1 ring-emerald-500/30"
                                  }`}
                                >
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      isProcessing
                                        ? "bg-amber-400 animate-ping"
                                        : isFailed
                                        ? "bg-red-400"
                                        : "bg-emerald-400"
                                    }`}
                                  />
                                  {isProcessing ? "Syncing" : isFailed ? "Failed" : "Ready"}
                                </span>
                              </div>

                              {/* Click-to-preview eye badge on hover */}
                              <div className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
                                <span className="flex items-center gap-1.5 rounded-full bg-ink-950/80 px-3 py-1.5 text-xs font-medium text-white shadow-xl backdrop-blur-md ring-1 ring-white/20">
                                  <Eye className="h-3.5 w-3.5 text-brand" /> Full View
                                </span>
                              </div>

                              {/* Delete button (top-right hover, stopPropagation) */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  confirmation.ask("deletePortrait", () =>
                                    deleteDirect(asset.id || asset.byteplusAssetId)
                                  );
                                }}
                                title="Delete portrait"
                                className="pointer-events-auto absolute right-2 top-2 z-30 grid h-7 w-7 cursor-pointer place-items-center rounded-lg bg-ink-950/85 text-white/70 opacity-90 transition hover:bg-red-600 hover:text-white sm:opacity-0 sm:group-hover:opacity-100 backdrop-blur-md"
                              >
                                <Trash2 className="h-3.5 w-3.5 pointer-events-none" />
                              </button>

                              {/* Quick Attach to Prompt button (bottom of thumbnail) */}
                              <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center justify-end bg-gradient-to-t from-ink-950/90 via-ink-950/40 to-transparent p-2.5 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleAttachToPrompt(asset, asset.name || activeGroup?.name || "Character");
                                  }}
                                  className={`flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold shadow-md transition ${
                                    isAttached
                                      ? "bg-emerald-500 text-zinc-950 font-bold"
                                      : "bg-white text-zinc-950 hover:bg-zinc-200"
                                  }`}
                                >
                                  {isAttached ? (
                                    <>
                                      <Check className="h-3.5 w-3.5" /> Added!
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles className="h-3.5 w-3.5" /> Use in Prompt
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Card metadata label */}
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center justify-between border-t border-line/60 p-2.5"
                            >
                              {editingId === (asset.id || asset.byteplusAssetId) ? (
                                <div className="flex w-full items-center gap-1">
                                  <input
                                    type="text"
                                    value={editName}
                                    autoFocus
                                    onChange={(e) => setEditName(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveRenamingAsset(asset.id || asset.byteplusAssetId);
                                      if (e.key === "Escape") setEditingId(null);
                                    }}
                                    className="w-full rounded border border-brand bg-ink-900 px-1.5 py-0.5 text-xs text-white focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => saveRenamingAsset(asset.id || asset.byteplusAssetId)}
                                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-brand hover:bg-brand/10"
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex w-full items-center justify-between">
                                  <span
                                    title={asset.name}
                                    className="truncate text-xs font-medium text-white/90"
                                  >
                                    {asset.name || "Portrait Reference"}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={(e) => startRenamingAsset(asset, e)}
                                      title="Rename portrait"
                                      className="grid h-5 w-5 place-items-center rounded text-white/40 transition hover:text-white opacity-90 sm:opacity-0 sm:group-hover:opacity-100"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Footer tip */}
              <footer className="flex items-center justify-between border-t border-line bg-ink-900/60 px-5 py-2.5 text-[11px] text-white/45">
                <span>
                  Tip: Click any portrait to view in <strong>Full View</strong>, or click <strong>&quot;Use in Prompt&quot;</strong> to reference it with <strong>@img</strong>.
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  Done
                </button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* High-Resolution Full View Lightbox Modal */}
      {selectedAssetForPreview && (
        <PortraitLightbox
          asset={selectedAssetForPreview}
          assets={filteredAssets}
          groupName={activeGroup?.name || "General Portraits"}
          onClose={() => setSelectedAssetForPreview(null)}
          onSelectAsset={(asset) => setSelectedAssetForPreview(asset)}
          onAttach={(asset, label) => handleAttachToPrompt(asset, label)}
          onDelete={(asset) => {
            confirmation.ask("deletePortrait", async () => {
              const res = await deleteDirect(asset.id || asset.byteplusAssetId);
              setSelectedAssetForPreview(null);
              return res;
            });
          }}
          onRename={async (assetId, newName) => {
            await renameDirect(assetId, newName);
            setSelectedAssetForPreview((prev) => (prev ? { ...prev, name: newName } : null));
          }}
        />
      )}

      {/* Confirmed Action Dialog rendered safely outside AnimatePresence */}
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}
