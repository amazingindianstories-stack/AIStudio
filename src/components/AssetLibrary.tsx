"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
} from "lucide-react";
import { useStore, type AssetDraft } from "@/lib/store";
import { ASSET_KINDS, type Asset, type AssetKind } from "@/lib/types";
import { cn, thumbUrl } from "@/lib/utils";

const KIND_ICON: Record<AssetKind, any> = {
  character: UserRound,
  outfit: Shirt,
  location: MapPin,
  style: Palette,
  prop: Box,
};

const KIND_LABEL: Record<AssetKind, string> = {
  character: "Character",
  outfit: "Outfit",
  location: "Location",
  style: "Style",
  prop: "Prop",
};

const KIND_HINT: Record<AssetKind, string> = {
  character: "A person whose face/identity must stay identical across shots.",
  outfit: "A specific set of clothing to keep consistent.",
  location: "A place/background to reuse across scenes.",
  style: "A look — palette, grain, lighting treatment.",
  prop: "An object that must look the same every time.",
};

export function AssetLibrary() {
  const open = useStore((s) => s.assetLibraryOpen);
  const setOpen = useStore((s) => s.setAssetLibraryOpen);
  const assets = useStore((s) => s.assets);
  const editing = useStore((s) => s.editingAsset);
  const setEditing = useStore((s) => s.setEditingAsset);
  const loadAssets = useStore((s) => s.loadAssets);

  useEffect(() => {
    if (open) loadAssets();
  }, [open, loadAssets]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] grid place-items-center p-4"
        >
          {/* overlay (click to close) — separate so it doesn't catch panel clicks */}
          <div
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="relative flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-pop"
          >
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
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
              <h2 className="text-sm font-semibold text-white">
                {editing
                  ? editing === "new"
                    ? "New asset"
                    : "Edit asset"
                  : "Asset library"}
              </h2>
              <span className="ml-auto" />
              <button
                onClick={() => setOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-white/70 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-4">
              {editing ? (
                <AssetEditor asset={editing === "new" ? null : editing} />
              ) : (
                <AssetList assets={assets} />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AssetList({ assets }: { assets: Asset[] }) {
  const setEditing = useStore((s) => s.setEditingAsset);
  const deleteAsset = useStore((s) => s.deleteAsset);
  const setOpen = useStore((s) => s.setAssetLibraryOpen);
  const prompt = useStore((s) => s.prompt);
  const setPrompt = useStore((s) => s.setPrompt);

  const insert = (slug: string) => {
    const tag = `@${slug}`;
    const next = `${prompt.trimEnd()} ${tag} `.replace(/^\s+/, "");
    setPrompt(next);
    setOpen(false);
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => setEditing("new")}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 py-3 text-sm font-medium text-white/70 transition hover:border-brand/40 hover:text-brand"
      >
        <Plus className="h-4 w-4" /> New asset
      </button>

      {assets.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No assets yet. Create a character, outfit, or location and reference it
          in any prompt with its <span className="text-brand">@tag</span> to keep
          it consistent.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {assets.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <div
                key={a.id}
                className="group flex gap-3 rounded-xl border border-line bg-ink-800 p-2.5"
              >
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-ink-700 ring-1 ring-line">
                  {a.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbUrl(a.images[0], 128)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-white/30">
                      <Icon className="h-5 w-5" />
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 text-white/45" />
                    <span className="truncate text-sm font-medium text-white">
                      {a.name}
                    </span>
                  </div>
                  <button
                    onClick={() => insert(a.slug)}
                    title="Insert tag into prompt"
                    className="mt-0.5 w-fit rounded bg-brand/15 px-1.5 py-0.5 text-[11px] font-semibold text-brand hover:bg-brand/25"
                  >
                    @{a.slug}
                  </button>
                  <span className="mt-0.5 text-[11px] text-white/35">
                    {KIND_LABEL[a.kind]} · {a.images.length} ref
                    {a.images.length === 1 ? "" : "s"}
                  </span>
                  <div className="mt-auto flex gap-1 pt-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={() => setEditing(a)}
                      className="grid h-6 w-6 place-items-center rounded text-white/60 hover:bg-white/10 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => deleteAsset(a.id)}
                      className="grid h-6 w-6 place-items-center rounded text-white/60 hover:bg-red-500/15 hover:text-red-300"
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
  );
}

function AssetEditor({ asset }: { asset: Asset | null }) {
  const saveAsset = useStore((s) => s.saveAsset);
  const setEditing = useStore((s) => s.setEditingAsset);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(asset?.name ?? "");
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? "character");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [images, setImages] = useState<string[]>(asset?.images ?? []);
  const [saving, setSaving] = useState(false);

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () =>
        setImages((prev) => [...prev, reader.result as string]);
      reader.readAsDataURL(f);
    });
    e.target.value = "";
  };

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const draft: AssetDraft = {
      id: asset?.id,
      kind,
      name: name.trim(),
      description: description.trim() || undefined,
      images,
    };
    await saveAsset(draft);
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* kind */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Type
        </label>
        <div className="flex flex-wrap gap-1.5">
          {ASSET_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 transition",
                  kind === k
                    ? "bg-brand/20 text-brand ring-brand/40"
                    : "bg-ink-700 text-white/65 ring-line hover:text-white"
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-white/35">{KIND_HINT[kind]}</p>
      </div>

      {/* name */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. "Priya"'
          className="w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-brand/40"
        />
      </div>

      {/* images */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Reference images{" "}
          <span className="text-white/30">
            — add 3–5 angles for a stronger lock
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div
              key={i}
              className="group relative h-20 w-20 overflow-hidden rounded-lg ring-1 ring-line"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbUrl(src, 160)} alt="" className="h-full w-full object-cover" />
              <button
                onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => fileRef.current?.click()}
            className="grid h-20 w-20 place-items-center rounded-lg border border-dashed border-white/15 text-white/50 transition hover:border-brand/40 hover:text-brand"
          >
            <Upload className="h-5 w-5" />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onFiles}
        />
      </div>

      {/* description */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-white/40">
          Locked description{" "}
          <span className="text-white/30">— reinforces the images (optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder={
            kind === "character"
              ? "e.g. 28yo woman, oval face, warm brown skin, long black wavy hair, small mole above left lip, almond eyes…"
              : "Distinctive details to keep identical every time…"
          }
          className="w-full resize-none rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-brand/40"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => setEditing(null)}
          className="rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!name.trim() || saving}
          className={cn(
            "rounded-lg px-4 py-2 text-sm font-semibold transition",
            name.trim() && !saving
              ? "bg-gradient-to-br from-brand to-accent text-ink-900 hover:brightness-110"
              : "cursor-not-allowed bg-ink-700 text-white/30"
          )}
        >
          {saving ? "Saving…" : asset ? "Save changes" : "Create asset"}
        </button>
      </div>
    </div>
  );
}
