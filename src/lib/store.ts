"use client";

import { create } from "zustand";
import type {
  Asset,
  AssetKind,
  GenerationItem,
  GenerationKind,
  Project,
  PublicUser,
} from "./types";
import {
  DEFAULTS,
  durationsForModel,
  resolutionsForModel,
  HISTORY_PAGE_SIZE,
} from "./config";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
}

export interface AssetDraft {
  id?: string;
  kind: AssetKind;
  name: string;
  description?: string;
  images: string[]; // mix of existing /assets paths and new data URLs
}

type RightTab = "project" | "history" | "favorites";

interface ComposerState {
  mode: GenerationKind;
  model: string;
  aspectRatio: string;
  resolution: string;
  duration: number;
  prompt: string;
  referenceImages: string[]; // data URLs
}

interface AppState extends ComposerState {
  items: GenerationItem[];
  hasMoreHistory: boolean;
  loading: boolean;
  generating: boolean;
  rightTab: RightTab;
  mobileHistoryOpen: boolean;
  activeId: string | null;
  search: string;
  filterKind: "all" | GenerationKind;
  selectedIds: string[]; // multi-select in the Assets tab

  // reusable reference assets (consistency library)
  assets: Asset[];
  assetLibraryOpen: boolean;
  editingAsset: Asset | "new" | null;

  // auth + attribution
  currentUser: CurrentUser | null;
  usersById: Record<string, PublicUser>;

  // projects (Project tab)
  projects: Project[];
  activeProjectId: string | null;
  activeFolderId: string | null; // null = All assets / unsorted

  // composer setters
  setMode: (mode: GenerationKind) => void;
  setModel: (model: string) => void;
  setAspectRatio: (r: string) => void;
  setResolution: (r: string) => void;
  setDuration: (d: number) => void;
  setPrompt: (p: string) => void;
  addReference: (dataUrl: string) => void;
  removeReference: (index: number) => void;

  // ui
  setRightTab: (t: RightTab) => void;
  setMobileHistoryOpen: (v: boolean) => void;
  setActiveId: (id: string | null) => void;
  setSearch: (s: string) => void;
  setFilterKind: (k: "all" | GenerationKind) => void;

  // data
  loadHistory: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  generate: () => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  retryTextToVideo: (id: string) => Promise<void>;
  editInComposer: (id: string) => void;
  cloneToComposer: (id: string) => Promise<void>;
  addReferenceFromUrl: (url: string) => Promise<void>;

  // assets
  loadAssets: () => Promise<void>;
  saveAsset: (draft: AssetDraft) => Promise<Asset | null>;
  deleteAsset: (id: string) => Promise<void>;
  setAssetLibraryOpen: (v: boolean) => void;
  setEditingAsset: (a: Asset | "new" | null) => void;

  // projects
  loadProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => void;
  setActiveFolder: (id: string | null) => void;
  createProject: (name: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createFolder: (projectId: string, name: string) => Promise<void>;
  renameFolder: (projectId: string, folderId: string, name: string) => Promise<void>;
  deleteFolder: (projectId: string, folderId: string) => Promise<void>;
  moveItem: (itemId: string, folderId: string | null) => Promise<void>;

  // multi-select
  toggleSelect: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  moveItemsToProject: (
    ids: string[],
    projectId: string,
    folderId?: string | null
  ) => Promise<void>;

  // auth
  loadMe: () => Promise<void>;
  loadUsers: () => Promise<void>;
  logout: () => Promise<void>;
}

const polling = new Set<string>();

export const useStore = create<AppState>((set, get) => ({
  // composer defaults (video by default, matching the reference)
  mode: "video",
  model: DEFAULTS.video.model,
  aspectRatio: DEFAULTS.video.aspectRatio,
  resolution: DEFAULTS.video.resolution,
  duration: DEFAULTS.video.duration,
  prompt: "",
  referenceImages: [],

  items: [],
  hasMoreHistory: true,
  loading: true,
  generating: false,
  rightTab: "project",
  mobileHistoryOpen: false,
  activeId: null,
  search: "",
  filterKind: "all",
  selectedIds: [],

  assets: [],
  assetLibraryOpen: false,
  editingAsset: null,

  currentUser: null,
  usersById: {},

  projects: [],
  activeProjectId: null,
  activeFolderId: null,

  setMode: (mode) => {
    const d = DEFAULTS[mode];
    set({
      mode,
      model: d.model,
      aspectRatio: d.aspectRatio,
      resolution: d.resolution,
      duration: "duration" in d ? d.duration : get().duration,
    });
  },
  setModel: (model) =>
    set((s) => {
      // Clamp duration and resolution into the new model's valid ranges
      // (e.g. switching to Higgsfield Seedance, whose max is 12s, while 15s
      // was selected; or to Seedance Mini, which caps at 720p).
      const allowed = durationsForModel(model);
      const max = Math.max(...allowed);
      const resolutions = resolutionsForModel(model, s.mode);
      const resolution = resolutions.includes(s.resolution)
        ? s.resolution
        : resolutions[resolutions.length - 1];
      return { model, duration: Math.min(s.duration, max), resolution };
    }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setResolution: (resolution) => set({ resolution }),
  setDuration: (duration) => set({ duration }),
  setPrompt: (prompt) => set({ prompt }),
  addReference: (dataUrl) =>
    set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReference: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),

  setRightTab: (rightTab) => set({ rightTab }),
  setMobileHistoryOpen: (mobileHistoryOpen) => set({ mobileHistoryOpen }),
  setActiveId: (activeId) => set({ activeId }),
  setSearch: (search) => set({ search }),
  setFilterKind: (filterKind) => set({ filterKind }),

  loadHistory: async () => {
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      const json = await res.json();
      const items: GenerationItem[] = json.items ?? [];
      const hasMoreHistory = items.length === HISTORY_PAGE_SIZE;
      set({ items, loading: false, hasMoreHistory });
      // resume polling for anything still in flight
      for (const it of items) {
        if (it.kind === "video" && (it.status === "running" || it.status === "queued")) {
          pollVideo(it.id, set, get);
        } else if (it.kind === "image" && it.status === "queued") {
          pollQueue(it.id, set, get);
        }
      }
    } catch {
      set({ loading: false });
    }
  },

  loadMoreHistory: async () => {
    const s = get();
    if (!s.hasMoreHistory || s.items.length === 0) return;
    const lastItem = s.items[s.items.length - 1];
    try {
      const res = await fetch(`/api/history?cursor=${lastItem.createdAt}`, { cache: "no-store" });
      const json = await res.json();
      const newItems: GenerationItem[] = json.items ?? [];
      const hasMoreHistory = newItems.length === HISTORY_PAGE_SIZE;
      set((st) => ({
        items: [...st.items, ...newItems],
        hasMoreHistory,
      }));
    } catch (e) {
      console.error("Failed to load more history:", e);
    }
  },

  generate: async () => {
    const s = get();
    const prompt = s.prompt.trim();
    if (!prompt || s.generating) return;

    set({ generating: true });
    const endpoint =
      s.mode === "image" ? "/api/generate/image" : "/api/generate/video";
    const payload = {
      prompt,
      model: s.model,
      aspectRatio: s.aspectRatio,
      resolution: s.resolution,
      duration: s.duration,
      referenceImages: s.referenceImages,
      projectId: s.activeProjectId ?? undefined,
      folderId: s.activeFolderId ?? undefined,
    };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const item: GenerationItem = await res.json();
      if (!res.ok) {
        throw new Error(item.error || `Server error: ${res.status}`);
      }
      if (item?.id) {
        set((st) => ({
          items: [item, ...st.items.filter((i) => i.id !== item.id)],
          prompt: "",
          rightTab: "history",
        }));
        if (item.kind === "video" && (item.status === "running" || item.status === "queued")) {
          pollVideo(item.id, set, get);
        } else if (item.kind === "image" && item.status === "queued") {
          pollQueue(item.id, set, get);
        }
      }
    } catch (e: any) {
      console.error("Generation request failed:", e);
      alert(e.message || "Failed to start generation.");
    } finally {
      set({ generating: false });
    }
  },

  removeItem: async (id) => {
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
    try {
      await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      /* ignore */
    }
  },

  toggleFavorite: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;

    const nextFavorite = !item.isFavorite;
    const favoritedAt = nextFavorite ? Date.now() : undefined;
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id ? { ...i, isFavorite: nextFavorite, favoritedAt } : i
      ),
    }));

    try {
      const res = await fetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isFavorite: nextFavorite }),
      });
      if (!res.ok) throw new Error("Favourite update failed.");
      const updated: GenerationItem = await res.json();
      if (updated?.id) {
        set((s) => ({
          items: s.items.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)),
        }));
      }
    } catch {
      set((s) => ({
        items: s.items.map((i) =>
          i.id === id
            ? {
                ...i,
                isFavorite: item.isFavorite,
                favoritedAt: item.favoritedAt,
              }
            : i
        ),
      }));
    }
  },

  retryTextToVideo: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || get().generating) return;
    // Drop @tags so leftover references don't confuse a no-image generation.
    const cleanPrompt = item.prompt
      .replace(/@[\w-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleanPrompt) return;

    set({ generating: true });
    try {
      const res = await fetch("/api/generate/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          model: item.model,
          aspectRatio: item.aspectRatio,
          resolution: item.resolution,
          duration: item.duration,
          referenceImages: [],
          projectId: item.projectId,
          folderId: item.folderId,
        }),
      });
      const newItem: GenerationItem = await res.json();
      if (newItem?.id) {
        set((st) => ({
          items: [newItem, ...st.items.filter((i) => i.id !== newItem.id)],
        }));
        if (
          newItem.kind === "video" &&
          (newItem.status === "running" || newItem.status === "queued")
        ) {
          pollVideo(newItem.id, set, get);
        }
      }
    } catch {
      /* ignore */
    } finally {
      set({ generating: false });
    }
  },

  editInComposer: (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    set({ mode: item.kind, prompt: item.prompt });
  },

  addReferenceFromUrl: async (url) => {
    // Fetch a generated image and add it to the composer as a reference (data
    // URL so every provider works) — enables the hero-first crowd workflow.
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      get().addReference(dataUrl);
    } catch {
      /* ignore */
    }
  },

  cloneToComposer: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    set({
      mode: item.kind,
      model: item.model,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution ?? get().resolution,
      duration: item.duration ?? get().duration,
      prompt: item.prompt,
      referenceImages: [],
    });
    // Restore the stored reference images as data URLs so every provider works.
    const paths = item.referenceImages ?? [];
    if (paths.length) {
      const dataUrls = await Promise.all(
        paths.map(async (p) => {
          try {
            const res = await fetch(p);
            const blob = await res.blob();
            return await new Promise<string>((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result as string);
              r.readAsDataURL(blob);
            });
          } catch {
            return null;
          }
        })
      );
      set({ referenceImages: dataUrls.filter((d): d is string => !!d) });
    }
  },

  loadAssets: async () => {
    try {
      const res = await fetch("/api/assets", { cache: "no-store" });
      const json = await res.json();
      set({ assets: json.assets ?? [] });
    } catch {
      /* ignore — library just stays empty */
    }
  },

  saveAsset: async (draft) => {
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const asset: Asset = await res.json();
      if (!asset?.id) return null;
      set((s) => ({
        assets: [asset, ...s.assets.filter((a) => a.id !== asset.id)],
        editingAsset: null,
      }));
      return asset;
    } catch {
      return null;
    }
  },

  deleteAsset: async (id) => {
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
    try {
      await fetch(`/api/assets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      /* ignore */
    }
  },

  setAssetLibraryOpen: (assetLibraryOpen) => set({ assetLibraryOpen }),
  setEditingAsset: (editingAsset) => set({ editingAsset }),

  loadProjects: async () => {
    try {
      // GET ensures a default project server-side (atomic — no duplicate races).
      const res = await fetch("/api/projects", { cache: "no-store" });
      const json = await res.json();
      const projects: Project[] = json.projects ?? [];
      set((s) => ({
        projects,
        activeProjectId:
          s.activeProjectId && projects.some((p) => p.id === s.activeProjectId)
            ? s.activeProjectId
            : projects[0]?.id ?? null,
      }));
    } catch {
      /* ignore */
    }
  },

  setActiveProject: (id) => set({ activeProjectId: id, activeFolderId: null }),
  setActiveFolder: (id) => set({ activeFolderId: id }),

  createProject: async (name) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createProject", name }),
    });
    const json = await res.json();
    if (json.projects) {
      set({
        projects: json.projects,
        activeProjectId: json.project?.id ?? get().activeProjectId,
        activeFolderId: null,
      });
    }
  },

  renameProject: async (id, name) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameProject", projectId: id, name }),
    });
    const json = await res.json();
    if (json.projects) set({ projects: json.projects });
  },

  deleteProject: async (id) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteProject", projectId: id }),
    });
    const json = await res.json();
    if (json.projects) {
      const projects: Project[] = json.projects;
      set((s) => ({
        projects,
        activeProjectId:
          s.activeProjectId === id ? projects[0]?.id ?? null : s.activeProjectId,
        activeFolderId: s.activeProjectId === id ? null : s.activeFolderId,
      }));
      // Items got orphaned server-side; reflect locally.
      set((s) => ({
        items: s.items.map((i) =>
          i.projectId === id
            ? { ...i, projectId: undefined, folderId: undefined }
            : i
        ),
      }));
    }
  },

  createFolder: async (projectId, name) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createFolder", projectId, name }),
    });
    const json = await res.json();
    if (json.projects) {
      set({ projects: json.projects });
      if (json.folder?.id) set({ activeFolderId: json.folder.id });
    }
  },

  renameFolder: async (projectId, folderId, name) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameFolder", projectId, folderId, name }),
    });
    const json = await res.json();
    if (json.projects) set({ projects: json.projects });
  },

  deleteFolder: async (projectId, folderId) => {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteFolder", projectId, folderId }),
    });
    const json = await res.json();
    if (json.projects) {
      set((s) => ({
        projects: json.projects,
        activeFolderId: s.activeFolderId === folderId ? null : s.activeFolderId,
        items: s.items.map((i) =>
          i.folderId === folderId ? { ...i, folderId: undefined } : i
        ),
      }));
    }
  },

  moveItem: async (itemId, folderId) => {
    const projectId = get().activeProjectId ?? undefined;
    // optimistic
    set((s) => ({
      items: s.items.map((i) =>
        i.id === itemId
          ? { ...i, projectId: projectId ?? i.projectId, folderId: folderId ?? undefined }
          : i
      ),
    }));
    try {
      await fetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, projectId, folderId }),
      });
    } catch {
      /* ignore */
    }
  },

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  selectAll: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),

  moveItemsToProject: async (ids, projectId, folderId = null) => {
    if (!ids.length) return;
    // optimistic local update + clear selection
    set((s) => ({
      items: s.items.map((i) =>
        ids.includes(i.id)
          ? { ...i, projectId, folderId: folderId ?? undefined }
          : i
      ),
      selectedIds: [],
    }));
    try {
      await Promise.all(
        ids.map((id) =>
          fetch("/api/history", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, projectId, folderId }),
          })
        )
      );
    } catch {
      /* ignore */
    }
  },

  loadMe: async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const json = await res.json();
      if (json.user) set({ currentUser: json.user });
      else window.location.href = "/login";
    } catch {
      /* ignore */
    }
  },

  loadUsers: async () => {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const json = await res.json();
      const map: Record<string, PublicUser> = {};
      for (const u of json.users ?? []) map[u.id] = u;
      set({ usersById: map });
    } catch {
      /* ignore */
    }
  },

  logout: async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  },
}));

function pollVideo(
  id: string,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (polling.has(id)) return;
  polling.add(id);

  const tick = async () => {
    try {
      const res = await fetch(
        `/api/generate/video/status?id=${encodeURIComponent(id)}`,
        { cache: "no-store" }
      );
      const item: GenerationItem = await res.json();
      if (item?.id) {
        set((s) => ({
          items: s.items.map((i) => (i.id === item.id ? { ...i, ...item } : i)),
        }));
        if (item.status === "succeeded" || item.status === "failed") {
          polling.delete(id);
          return;
        }
      }
    } catch {
      /* keep trying */
    }
    setTimeout(tick, 4000);
  };

  setTimeout(tick, 3000);
}

function pollQueue(
  id: string,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (polling.has(id)) return;
  polling.add(id);

  const tick = async () => {
    try {
      const res = await fetch(`/api/queue/status?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      
      if (data.status === "queued" && data.position === 0) {
        // It's our turn!
        const execRes = await fetch(`/api/queue/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const finalItem: GenerationItem = await execRes.json();
        if (finalItem?.id) {
          set((s) => ({
            items: s.items.map((i) => (i.id === finalItem.id ? { ...i, ...finalItem } : i)),
          }));
        }
        polling.delete(id);
        return; // done
      } else if (data.status === "succeeded" || data.status === "failed") {
        // Somehow finished already or failed
        polling.delete(id);
        return;
      }
      // Still queued and position > 0, wait and poll again
    } catch {
      /* keep trying */
    }
    setTimeout(tick, 3000);
  };

  setTimeout(tick, 1000);
}
