"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Plus,
  Upload,
  Trash2,
  Pencil,
  UserRound,
  Shirt,
  MapPin,
  Palette,
  Box,
  Library,
  ArrowLeft,
  Search,
  Sparkles,
  AudioLines,
  Paperclip,
  Eye,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { ASSET_KINDS } from "@/lib/types";
import { sanitizeSlug } from "@/lib/mentions";
import { cn, thumbUrl } from "@/lib/utils";
import { uploadOriginalReference } from "@/lib/client-reference-upload";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useConfirmedAction } from "./useConfirmedAction";
import { AssetLightbox } from "./AssetLightbox";
import { ProgressiveImage } from "./ProgressiveImage";

export const KIND_ICON = {
  character: UserRound,
  prop: Box,
  location: MapPin,
  style: Palette,
  outfit: Shirt,
  audio: AudioLines,
  other: Sparkles,
};

export const KIND_LABEL = {
  character: "Character",
  prop: "Prop",
  location: "Location",
  style: "Style",
  outfit: "Outfit",
  audio: "Audio",
  other: "Other",
};

export const KIND_HINT = {
  character: "A character or turnaround sheet whose face and identity stay consistent.",
  prop: "A distinct object, weapon, or prop to keep identical across shots.",
  location: "A scene, environment, or background to reuse across scenes.",
  style: "An aesthetic look — color palette, lighting, texture, or medium.",
  outfit: "A specific costume or armor set to keep consistent.",
  audio: "An audio cue or theme note.",
  other: "Any custom reference material.",
};

const CATEGORY_TABS = [
  { id: "all", label: "All" },
  { id: "character", label: "Characters" },
  { id: "prop", label: "Props" },
  { id: "location", label: "Scenes" },
  { id: "style", label: "Styles" },
  { id: "outfit", label: "Outfits" },
  { id: "other", label: "Other" },
];

export function AssetLibrary() {
  const open = useStore((s) => s.assetLibraryOpen);
  const setOpen = useStore((s) => s.setAssetLibraryOpen);
  const assets = useStore((s) => s.assets);
  const editing = useStore((s) => s.editingAsset);
  const setEditing = useStore((s) => s.setEditingAsset);
  const loadAssets = useStore((s) => s.loadAssets);
  const assetsLoading = useStore((s) => s.assetsLoading);
  const assetsRefreshing = useStore((s) => s.assetsRefreshing);
  const assetsError = useStore((s) => s.assetsError);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  useEffect(() => {
    if (open) loadAssets(activeProjectId);
  }, [open, loadAssets, activeProjectId]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] grid place-items-center p-4"
        >
          {/* overlay (click to close) */}
          <div
            onClick={() => {
              setOpen(false);
              setEditing(null);
            }}
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="relative flex max-h-[88dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-pop"
          >
            <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
              {editing ? (
                <button
                  onClick={() => setEditing(null)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-white/70 hover:bg-white/10"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              ) : (
                <Library className="h-5 w-5 text-brand" />
              )}
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">
                    {editing
                      ? editing === "new"
                        ? "Add Material Sheet"
                        : "Edit Material Sheet"
                      : "Material Library"}
                  </h2>
                  {activeProject && (
                    <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/80">
                      {activeProject.name}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-white/40">
                  {editing
                    ? "Single reference sheet or turnaround per asset, referenceable by @name"
                    : "Reusable turnaround sheets and materials for this project. Reference with @name in prompts."}
                </p>
              </div>
              <span className="ml-auto" />
              <button
                onClick={() => {
                  setOpen(false);
                  setEditing(null);
                }}
                className="grid h-8 w-8 place-items-center rounded-lg text-white/70 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-5">
              {editing ? (
                <AssetEditor asset={editing === "new" ? null : editing} />
              ) : (
                <AssetList
                  assets={assets}
                  loading={assetsLoading}
                  refreshing={assetsRefreshing}
                  error={assetsError}
                  activeProject={activeProject}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AssetList({ assets, loading, refreshing, error, activeProject: propActiveProject }) {
  const setEditing = useStore((s) => s.setEditingAsset);
  const deleteAsset = useStore((s) => s.deleteAsset);
  const setOpen = useStore((s) => s.setAssetLibraryOpen);
  const attachMaterialToComposer = useStore((s) => s.attachMaterialToComposer);
  const prompt = useStore((s) => s.prompt);
  const setPrompt = useStore((s) => s.setPrompt);
  const confirmation = useConfirmedAction();
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject =
    propActiveProject ?? (projects.find((p) => p.id === activeProjectId) ?? null);
  const loadAssets = useStore((s) => s.loadAssets);

  const [activeTab, setActiveTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAssetForPreview, setSelectedAssetForPreview] = useState(null);

  const filteredAssets = useMemo(() => {
    return assets.filter((a) => {
      if (activeTab !== "all") {
        if (activeTab === "other") {
          if (a.kind !== "other" && a.kind !== "audio") return false;
        } else if (a.kind !== activeTab) {
          return false;
        }
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = a.name?.toLowerCase().includes(q);
        const matchesSlug = a.slug?.toLowerCase().includes(q);
        const matchesDesc = a.description?.toLowerCase().includes(q);
        return matchesName || matchesSlug || matchesDesc;
      }
      return true;
    });
  }, [assets, activeTab, searchQuery]);

  const insertTag = (slug) => {
    const tag = `@${slug}`;
    const next = `${prompt.trimEnd()} ${tag} `.replace(/^\s+/, "");
    setPrompt(next);
    setOpen(false);
  };

  const handleAttach = (asset) => {
    attachMaterialToComposer(asset);
  };

  return (
    <>
      <div className="space-y-4">
        {/* Top actions: Search bar + New Asset Button */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search materials or @slug..."
              className="w-full rounded-xl border border-line bg-ink-800 py-2 pl-9 pr-3 text-sm text-white placeholder:text-white/30 focus:border-brand/40 focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => setEditing("new")}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-brand/15 px-3.5 py-2 text-sm font-semibold text-brand transition hover:bg-brand/25 active:scale-95"
          >
            <Plus className="h-4 w-4" /> Add Material
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scroll-thin">
          {CATEGORY_TABS.map((tab) => {
            const count =
              tab.id === "all"
                ? assets.length
                : tab.id === "other"
                ? assets.filter((a) => a.kind === "other" || a.kind === "audio").length
                : assets.filter((a) => a.kind === tab.id).length;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition",
                  activeTab === tab.id
                    ? "bg-white text-zinc-950 font-semibold shadow-sm"
                    : "bg-ink-800 text-white/70 hover:bg-ink-750 hover:text-white border border-line/60"
                )}
              >
                {tab.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[10px]",
                    activeTab === tab.id ? "bg-black/15 text-zinc-950 font-bold" : "bg-white/10 text-white/50"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Loading / Empty / Grid display */}
        {loading && assets.length === 0 ? (
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            role="status"
            aria-busy="true"
            aria-label="Loading materials"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-xl border border-line bg-ink-800 p-3"
              >
                <div className="skeleton h-32 w-full rounded-lg" />
                <div className="skeleton h-4 w-2/3 rounded" />
                <div className="skeleton h-3 w-1/3 rounded" />
              </div>
            ))}
            <span className="sr-only">Loading materials…</span>
          </div>
        ) : error && assets.length === 0 ? (
          <div role="alert" className="grid min-h-56 place-items-center text-center text-sm text-white/55">
            <div><p>{error}</p><button onClick={() => loadAssets(activeProjectId)} className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 font-medium text-white hover:bg-white/15">Retry</button></div>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line py-12 px-4 text-center">
            <Library className="h-10 w-10 text-white/20 mb-3" />
            <h3 className="text-sm font-semibold text-white/70">
              {searchQuery ? "No matching materials" : "No materials in this category"}
            </h3>
            <p className="mt-1 max-w-sm text-xs text-white/40">
              {searchQuery
                ? `No materials matched "${searchQuery}". Try a different name or clear the search.`
                : activeProject
                ? `No materials in "${activeProject.name}" yet. Upload a character turnaround sheet, prop, or location for this project.`
                : "Upload a character turnaround sheet, prop, or location to reference by @name in your prompts."}
            </p>
            {!searchQuery && (
              <button
                onClick={() => setEditing("new")}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/15"
              >
                <Plus className="h-3.5 w-3.5" /> Add First Material
              </button>
            )}
          </div>
        ) : (
          <>
          {refreshing && <div role="status" className="mb-3 text-center text-xs text-white/40">Refreshing materials…</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredAssets.map((a) => {
              const Icon = KIND_ICON[a.kind] || Box;
              const imageUrl = a.images?.[0];

              return (
                <div
                  key={a.id}
                  className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-ink-800 transition hover:border-brand/40"
                >
                  {/* Single Image / Sheet Preview with uncropped containment */}
                  <div
                    onClick={() => setSelectedAssetForPreview(a)}
                    className="relative aspect-[16/10] w-full overflow-hidden bg-ink-950/85 p-1 flex items-center justify-center cursor-pointer group/thumb"
                  >
                    {imageUrl ? (
                      <ProgressiveImage
                        src={thumbUrl(imageUrl, 512)}
                        alt={a.name}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full"
                        imageClassName="object-contain transition duration-300 group-hover/thumb:scale-105"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-white/30">
                        <Icon className="h-8 w-8" />
                      </div>
                    )}

                    {/* Full View Hover Overlay */}
                    <div className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition group-hover/thumb:opacity-100 bg-black/35 backdrop-blur-[1px]">
                      <span className="flex items-center gap-1.5 rounded-full bg-ink-950/90 px-3 py-1.5 text-xs font-medium text-white shadow-xl backdrop-blur-md ring-1 ring-white/20">
                        <Eye className="h-3.5 w-3.5 text-white" /> Full View
                      </span>
                    </div>

                    {/* Kind Badge */}
                    <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm pointer-events-none">
                      <Icon className="h-3 w-3 text-brand" />
                      <span>{KIND_LABEL[a.kind] || "Asset"}</span>
                    </div>

                    {/* Quick Card Edit / Delete Actions */}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-2 top-2 flex items-center gap-1 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition z-10"
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(a);
                        }}
                        title="Edit material"
                        className="grid h-6 w-6 place-items-center rounded-md bg-black/65 text-white/75 backdrop-blur-sm transition hover:bg-white/20 hover:text-white"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmation.ask("deleteAsset", () => deleteAsset(a.id));
                        }}
                        aria-label={`Delete ${a.name}`}
                        title="Delete material"
                        className="grid h-6 w-6 place-items-center rounded-md bg-black/65 text-white/75 backdrop-blur-sm transition hover:bg-red-600/80 hover:text-white"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {/* Card Content & Tag Buttons */}
                  <div className="flex flex-1 flex-col p-3">
                    <div className="flex items-center justify-between gap-1">
                      <h4 className="truncate text-sm font-semibold text-white" title={a.name}>
                        {a.name}
                      </h4>
                    </div>

                    {a.description && (
                      <p className="mt-1 line-clamp-1 text-[11px] text-white/40" title={a.description}>
                        {a.description}
                      </p>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                      {/* @tag pill */}
                      <button
                        onClick={() => insertTag(a.slug)}
                        title="Click to insert @tag into prompt"
                        className="inline-flex items-center gap-1 rounded-md bg-brand/15 px-2 py-1 text-xs font-mono font-semibold text-brand transition hover:bg-brand/25"
                      >
                        @{a.slug}
                      </button>

                      {/* Attach to Composer button */}
                      <button
                        onClick={() => handleAttach(a)}
                        title="Attach sheet to composer reference shelf and prompt"
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-ink-750 px-2 py-1 text-xs font-medium text-white/80 transition hover:border-brand/40 hover:text-brand"
                      >
                        <Paperclip className="h-3 w-3" />
                        <span>Attach</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </div>

      {/* Full Sheet Lightbox Modal */}
      {selectedAssetForPreview && (
        <AssetLightbox
          asset={selectedAssetForPreview}
          assets={filteredAssets}
          onClose={() => setSelectedAssetForPreview(null)}
          onSelectAsset={(asset) => setSelectedAssetForPreview(asset)}
          onAttach={(asset) => handleAttach(asset)}
          onEdit={(asset) => {
            setSelectedAssetForPreview(null);
            setEditing(asset);
          }}
          onDelete={(asset) => {
            confirmation.ask("deleteAsset", async () => {
              const res = await deleteAsset(asset.id);
              setSelectedAssetForPreview(null);
              return res;
            });
          }}
        />
      )}

      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}

function AssetEditor({ asset }) {
  const saveAsset = useStore((s) => s.saveAsset);
  const setEditing = useStore((s) => s.setEditingAsset);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const fileRef = useRef(null);

  const [name, setName] = useState(asset?.name ?? "");
  const [kind, setKind] = useState(asset?.kind ?? "character");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [image, setImage] = useState(asset?.images?.[0] ?? "");
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Live slug preview
  const liveSlug = useMemo(() => {
    return sanitizeSlug(name || "sheet");
  }, [name]);

  const handleFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setSelectedFile(file);
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      setImage(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const submit = async () => {
    if (!name.trim() || (!image && !selectedFile) || saving) return;
    setSaving(true);
    setError("");

    let finalImageUrl = image;
    if (selectedFile) {
      try {
        finalImageUrl = await uploadOriginalReference(selectedFile);
      } catch (uploadErr) {
        console.warn("Direct reference upload failed, falling back to data URL:", uploadErr);
      }
    }

    const draft = {
      id: asset?.id,
      kind,
      name: name.trim(),
      description: description.trim() || undefined,
      image: finalImageUrl,
      projectId: asset?.projectId || activeProjectId || undefined,
    };
    const res = await saveAsset(draft);
    setSaving(false);
    if (res?.ok) {
      setEditing(null);
    } else {
      setError(res?.error || "Failed to save material. Please try again.");
    }
  };

  return (
    <div className="space-y-4">
      {/* Kind Selector */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Material Type
        </label>
        <div className="flex flex-wrap gap-1.5">
          {ASSET_KINDS.map((k) => {
            const Icon = KIND_ICON[k] || Box;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 transition",
                  kind === k
                    ? "bg-white text-zinc-950 font-semibold ring-1 ring-white shadow-sm"
                    : "bg-ink-800 text-white/65 ring-line hover:text-white"
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {KIND_LABEL[k] || k}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-white/40">{KIND_HINT[kind]}</p>
      </div>

      {/* Name Input with live @tag preview */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[11px] font-medium uppercase tracking-wide text-white/40">
            Material Name & @Mention Tag
          </label>
          <span className="font-mono text-xs font-semibold text-brand">
            Mention Tag: @{liveSlug}
          </span>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. "Sati", "Scene 1", "Cyber Sword"'
          className="w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-brand/40"
        />
      </div>

      {/* Single Turnaround / Material Sheet Upload */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Material Sheet / Turnaround Image{" "}
          <span className="text-white/30">— 1 single sheet / image per asset</span>
        </label>

        {image ? (
          <div className="relative group w-full max-w-sm overflow-hidden rounded-xl border border-line bg-ink-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt="Material Sheet"
              className="max-h-64 w-full object-contain bg-ink-950"
            />
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-white/30"
              >
                <Upload className="h-3.5 w-3.5" /> Replace
              </button>
              <button
                type="button"
                onClick={() => {
                  setImage("");
                  setSelectedFile(null);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-red-600/80 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm transition hover:bg-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition",
              dragActive
                ? "border-brand bg-brand/5 text-brand"
                : "border-white/15 bg-ink-800 hover:border-brand/40 text-white/60"
            )}
          >
            <Upload className="h-8 w-8 mb-2 text-white/40" />
            <p className="text-sm font-medium text-white">
              Drag and drop your single turnaround sheet here, or click to browse
            </p>
            <p className="mt-1 text-xs text-white/35">
              PNG, JPG, WEBP up to 20MB. Upload character sheets, props, scene plates, or styles.
            </p>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onFileInputChange}
        />
      </div>

      {/* Description */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Visual Guidance / Description{" "}
          <span className="text-white/30">— details reinforced in prompts (optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder={
            kind === "character"
              ? "e.g. Sati, ancient Indian warrior princess, golden armor, dark flowing braid, fierce focused eyes…"
              : "Key visual traits, color palettes, or physical details to preserve…"
          }
          className="w-full resize-none rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-brand/40"
        />
      </div>

      {/* Error Banner */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Action Footer */}
      <div className="flex justify-end gap-2 pt-2 border-t border-line">
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="rounded-lg px-4 py-2 text-sm text-white/70 hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!name.trim() || (!image && !selectedFile) || saving}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-semibold transition",
            name.trim() && (image || selectedFile) && !saving
              ? "bg-white text-zinc-950 font-semibold hover:bg-zinc-200 shadow-sm"
              : "cursor-not-allowed bg-ink-700 text-white/30"
          )}
        >
          {saving ? "Saving…" : asset ? "Save Changes" : "Save Material"}
        </button>
      </div>
    </div>
  );
}
