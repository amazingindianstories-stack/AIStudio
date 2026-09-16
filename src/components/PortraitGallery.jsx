"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Plus,
  Upload,
  Trash2,
  UserRound,
  ArrowLeft,
  Images,
  CheckCircle2,
  Clock,
  AlertCircle,
  Sparkles,
  Info,
  Copy,
  Check,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { thumbUrl } from "@/lib/utils";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { useConfirmedAction } from "./useConfirmedAction";

export function PortraitGallery() {
  const open = useStore((s) => s.portraitGalleryOpen);
  const setOpen = useStore((s) => s.setPortraitGalleryOpen);
  const groups = useStore((s) => s.portraitGroups);
  const loading = useStore((s) => s.portraitGroupsLoading);
  const loadGroups = useStore((s) => s.loadPortraitGroups);
  const selectedGroup = useStore((s) => s.selectedPortraitGroup);
  const setSelectedGroup = useStore((s) => s.setSelectedPortraitGroup);

  const [creatingGroup, setCreatingGroup] = useState(false);

  useEffect(() => {
    if (open) {
      loadGroups();
    } else {
      setCreatingGroup(false);
      setSelectedGroup(null);
    }
  }, [open, loadGroups, setSelectedGroup]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] grid place-items-center p-3 sm:p-4"
        >
          {/* overlay backdrop */}
          <div
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="relative flex max-h-[88dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-pop"
          >
            {/* Header */}
            <header className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
              {selectedGroup || creatingGroup ? (
                <button
                  onClick={() => {
                    if (creatingGroup) setCreatingGroup(false);
                    else setSelectedGroup(null);
                  }}
                  className="grid h-8 w-8 place-items-center rounded-lg text-white/70 hover:bg-white/10"
                  aria-label="Back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              ) : (
                <Images className="h-5 w-5 text-brand" />
              )}
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-white">
                  {creatingGroup
                    ? "New Character"
                    : selectedGroup
                    ? selectedGroup.name
                    : "Portrait Gallery"}
                </h2>
                <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                  BytePlus ModelArk
                </span>
              </div>
              <span className="ml-auto" />
              <button
                onClick={() => setOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-white/70 hover:bg-white/10"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {/* Content Body */}
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-4 sm:p-5">
              {creatingGroup ? (
                <CreateGroupForm onCancel={() => setCreatingGroup(false)} />
              ) : selectedGroup ? (
                <CharacterDetail group={selectedGroup} />
              ) : (
                <CharacterList
                  groups={groups}
                  loading={loading}
                  onCreateClick={() => setCreatingGroup(true)}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CharacterList({ groups, loading, onCreateClick }) {
  const setSelectedGroup = useStore((s) => s.setSelectedPortraitGroup);
  const deleteGroup = useStore((s) => s.deletePortraitGroup);
  const attachPortrait = useStore((s) => s.attachPortraitToComposer);
  const confirmation = useConfirmedAction();
  const [search, setSearch] = useState("");

  const filtered = groups.filter((g) =>
    (g.name || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div className="space-y-4">
        {/* Info callout */}
        <div className="flex items-start gap-2.5 rounded-xl border border-brand/20 bg-brand/10 p-3 text-xs text-white/80">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div>
            <span className="font-semibold text-white">Trusted AI Character Personas:</span>{" "}
            Registering character portraits here uploads them to your private BytePlus ModelArk library.
            Seedance 2.0 / 2.5 can generate videos with them consistently without anti-deepfake privacy rejections.
          </div>
        </div>

        {/* Action bar & Search */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <input
            type="text"
            placeholder="Search characters…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 rounded-xl border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
          />
          <button
            onClick={onCreateClick}
            className="flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-brand-light"
          >
            <Plus className="h-4 w-4" /> New Character
          </button>
        </div>

        {/* Group list */}
        {loading && groups.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex gap-3 rounded-xl border border-line bg-ink-800 p-3"
              >
                <div className="skeleton h-16 w-16 shrink-0 rounded-lg" />
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                  <div className="skeleton h-4 w-2/3 rounded" />
                  <div className="skeleton h-3 w-1/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-white/40">
            {search ? (
              "No characters match your search."
            ) : (
              <div>
                <p>No characters created yet.</p>
                <p className="mt-1 text-xs text-white/30">
                  Click <span className="text-brand font-medium">New Character</span> to create a consistent actor for your videos.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {filtered.map((g) => {
              const primaryAsset =
                g.assets?.find((a) => a.imageUrl === g.primaryAssetId) ||
                g.assets?.find((a) => a.status === "Active") ||
                g.assets?.[0];

              const activeAsset = g.assets?.find((a) => a.status === "Active");

              return (
                <div
                  key={g.id}
                  className="group relative flex gap-3 rounded-xl border border-line bg-ink-800 p-3 transition hover:border-line-strong"
                >
                  {/* Thumbnail */}
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-ink-700 ring-1 ring-line">
                    {primaryAsset?.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbUrl(primaryAsset.imageUrl, 160)}
                        alt={g.name}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-white/30">
                        <UserRound className="h-6 w-6" />
                      </div>
                    )}
                  </div>

                  {/* Info & Actions */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-white">
                        {g.name}
                      </span>
                    </div>

                    {g.description && (
                      <p className="line-clamp-1 mt-0.5 text-xs text-white/50">
                        {g.description}
                      </p>
                    )}

                    <div className="mt-1 flex items-center gap-2 text-[11px] text-white/40">
                      <span>{g.assets?.length || 0} ref{(g.assets?.length || 0) === 1 ? "" : "s"}</span>
                      {g.activeCount > 0 && (
                        <span className="flex items-center gap-1 text-emerald-400 font-medium">
                          <CheckCircle2 className="h-3 w-3" /> {g.activeCount} active
                        </span>
                      )}
                      {g.processingCount > 0 && (
                        <span className="flex items-center gap-1 text-amber-400 font-medium animate-pulse">
                          <Clock className="h-3 w-3" /> {g.processingCount} processing
                        </span>
                      )}
                    </div>

                    <div className="mt-auto flex items-center gap-2 pt-2">
                      <button
                        onClick={() => setSelectedGroup(g)}
                        className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/15"
                      >
                        Manage
                      </button>

                      {activeAsset && (
                        <button
                          onClick={() => attachPortrait(activeAsset, g.name)}
                          className="rounded-lg bg-brand/15 px-2.5 py-1 text-xs font-semibold text-brand transition hover:bg-brand/25"
                          title="Attach active portrait to prompt"
                        >
                          Use in Prompt
                        </button>
                      )}

                      <button
                        onClick={() =>
                          confirmation.ask("deletePortraitGroup", () => deleteGroup(g.id))
                        }
                        aria-label={`Delete ${g.name}`}
                        className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-white/40 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/15 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}

function CreateGroupForm({ onCancel }) {
  const createGroup = useStore((s) => s.createPortraitGroup);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please enter a character name.");
      return;
    }
    setLoading(true);
    setError("");
    const res = await createGroup(name.trim(), description.trim());
    setLoading(false);
    if (!res.ok) {
      setError(res.error || "Failed to create character.");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-white/70">
          Character / Persona Name <span className="text-brand">*</span>
        </label>
        <input
          type="text"
          placeholder="e.g. Elena (Hero), Marcus, Cyber Detective"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={loading}
          autoFocus
          className="mt-1 w-full rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-sm text-white placeholder-white/35 focus:border-brand focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-white/70">
          Description (Optional)
        </label>
        <textarea
          rows={3}
          placeholder="Character traits, age, wardrobe, or role..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={loading}
          className="mt-1 w-full rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-sm text-white placeholder-white/35 focus:border-brand focus:outline-none"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-white/70 hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-ink-950 transition hover:bg-brand-light disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create Character"}
        </button>
      </div>
    </form>
  );
}

function CharacterDetail({ group }) {
  const fileInputRef = useRef(null);
  const uploadAsset = useStore((s) => s.uploadPortraitAsset);
  const deleteAsset = useStore((s) => s.deletePortraitAsset);
  const loadAssets = useStore((s) => s.loadPortraitAssets);
  const attachPortrait = useStore((s) => s.attachPortraitToComposer);
  const confirmation = useConfirmedAction();

  const [uploading, setUploading] = useState(false);
  const [uploadRole, setUploadRole] = useState("reference");
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);

  const assets = group.assets || [];

  // Polling for any processing assets
  const hasProcessing = assets.some((a) => a.status === "Processing");

  useEffect(() => {
    if (!hasProcessing) return;
    const interval = setInterval(() => {
      loadAssets(group.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [hasProcessing, group.id, loadAssets]);

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const file = files[0];

    // Client-side file size guard
    if (file.size > 30 * 1024 * 1024) {
      setError("File exceeds BytePlus 30MB limit.");
      return;
    }

    setUploading(true);
    setError("");

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await uploadAsset(group.id, {
        dataUrl,
        name: file.name.replace(/\.[^/.]+$/, ""),
        role: uploadRole,
      });

      if (!res.ok) {
        setError(res.error || "Upload failed.");
      }
    } catch (err) {
      setError(err?.message || "Failed to read image file.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const copyAssetId = (assetId) => {
    navigator.clipboard.writeText(`asset://${assetId}`);
    setCopiedId(assetId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <>
      <div className="space-y-4">
        {/* Guidance Banner (From BytePlus Doc 2333565 Best Practices) */}
        <div className="rounded-xl border border-line bg-ink-800/80 p-3.5 text-xs space-y-2">
          <div className="flex items-center gap-1.5 font-semibold text-white">
            <Info className="h-4 w-4 text-brand" />
            <span>BytePlus Character Asset Best Practices</span>
          </div>
          <ul className="list-disc pl-5 space-y-1 text-white/70">
            <li>
              <span className="text-white font-medium">Full-body reference:</span> Vertical layout, clear frontal full-body view of the character.
            </li>
            <li>
              <span className="text-white font-medium">Facial close-up:</span> Frontal close-up with neutral expression above the shoulders, occupying ~2/3 of frame.
            </li>
            <li>
              <span className="text-white font-medium">Format:</span> JPG, PNG, WEBP. Dimensions 300px–6000px, aspect ratio between 0.4 and 2.5, &lt;30MB.
            </li>
          </ul>
        </div>

        {/* Upload bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-ink-800 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/60">Asset Role:</span>
            <select
              value={uploadRole}
              onChange={(e) => setUploadRole(e.target.value)}
              className="rounded-lg border border-line bg-ink-700 px-2.5 py-1 text-xs text-white focus:border-brand focus:outline-none"
            >
              <option value="full_body">Full-body frontal</option>
              <option value="close_up">Facial close-up</option>
              <option value="reference">General reference</option>
            </select>
          </div>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={handleFiles}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-brand-light disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? "Uploading to ModelArk..." : "Upload Reference"}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-500/15 p-2.5 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Assets Grid */}
        {assets.length === 0 ? (
          <div className="py-10 text-center text-sm text-white/40">
            <p>No reference images uploaded yet for {group.name}.</p>
            <p className="mt-1 text-xs text-white/30">
              Upload a full-body and close-up image to create a consistent actor.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((a) => {
              const isActive = a.status === "Active";
              const isProcessing = a.status === "Processing";
              const isFailed = a.status === "Failed";

              return (
                <div
                  key={a.id}
                  className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-ink-800 p-2.5 transition hover:border-line-strong"
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-ink-700 ring-1 ring-line">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbUrl(a.imageUrl, 240)}
                      alt={a.name || "Reference"}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />

                    {/* Role badge */}
                    <span className="absolute top-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">
                      {a.role === "full_body"
                        ? "Full Body"
                        : a.role === "close_up"
                        ? "Close-Up"
                        : "Reference"}
                    </span>

                    {/* Status badge */}
                    <div className="absolute top-2 right-2">
                      {isActive && (
                        <span className="flex items-center gap-1 rounded bg-emerald-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400 backdrop-blur-sm">
                          <CheckCircle2 className="h-3 w-3" /> Active
                        </span>
                      )}
                      {isProcessing && (
                        <span className="flex items-center gap-1 rounded bg-amber-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 backdrop-blur-sm animate-pulse">
                          <Clock className="h-3 w-3" /> Processing
                        </span>
                      )}
                      {isFailed && (
                        <span className="flex items-center gap-1 rounded bg-red-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-red-400 backdrop-blur-sm">
                          <AlertCircle className="h-3 w-3" /> Failed
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex flex-col gap-1 text-xs">
                    <span className="truncate font-medium text-white">
                      {a.name || "Portrait Reference"}
                    </span>

                    {a.byteplusAssetId && (
                      <div className="flex items-center justify-between gap-1 text-[11px] text-white/40">
                        <span className="truncate font-mono">
                          asset://{a.byteplusAssetId.slice(0, 16)}…
                        </span>
                        <button
                          onClick={() => copyAssetId(a.byteplusAssetId)}
                          title="Copy asset URI"
                          className="grid h-5 w-5 place-items-center rounded hover:bg-white/10 hover:text-white"
                        >
                          {copiedId === a.byteplusAssetId ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    )}

                    {isFailed && a.statusMessage && (
                      <p className="text-[10px] text-red-400">{a.statusMessage}</p>
                    )}

                    <div className="mt-1 flex items-center justify-between pt-1 border-t border-line/60">
                      {isActive ? (
                        <button
                          onClick={() => attachPortrait(a, group.name)}
                          className="rounded bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-brand transition hover:bg-brand/25"
                        >
                          Use in Prompt
                        </button>
                      ) : (
                        <span className="text-[10px] text-white/30">
                          {isProcessing ? "Processing in ModelArk…" : "Unavailable"}
                        </span>
                      )}

                      <button
                        onClick={() =>
                          confirmation.ask("deletePortraitAsset", () =>
                            deleteAsset(group.id, a.id)
                          )
                        }
                        className="grid h-6 w-6 place-items-center rounded text-white/40 hover:bg-red-500/15 hover:text-red-300"
                        title="Delete reference"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ConfirmActionDialog {...confirmation.dialogProps} />
    </>
  );
}
