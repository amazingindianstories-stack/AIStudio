export type GenerationKind = "image" | "video";

export type GenerationStatus = "queued" | "running" | "succeeded" | "failed";

export interface AspectRatio {
  label: string; // e.g. "21:9"
  value: string; // same string, used as id
  w: number;
  h: number;
}

export interface GenerationParams {
  prompt: string;
  kind: GenerationKind;
  aspectRatio: string; // "16:9"
  resolution?: string; // "1080p" | "720p" | "480p"
  duration?: number; // seconds (video)
  model: string; // display name of the selected model
  referenceImages?: string[]; // data URLs / urls used as conditioning
}

export interface GenerationItem {
  id: string;
  kind: GenerationKind;
  status: GenerationStatus;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution?: string;
  duration?: number;
  url?: string; // image or video url (served locally)
  poster?: string; // poster/thumbnail for video
  referenceImages?: string[]; // uploaded reference images used (public paths), saved for retrieval/clone
  error?: string;
  moderationBlocked?: boolean; // provider rejected a reference image (privacy/deepfake filter)
  taskId?: string; // provider task id (for polling)
  projectId?: string; // owning project (for the Project tab)
  folderId?: string; // shot/folder within the project (null = unsorted / All assets)
  userId?: string; // who generated it (attribution)
  costCents?: number; // computed cost of this generation, in cents
  isFavorite?: boolean; // starred by the team for quick review/use
  favoritedAt?: number; // when the item was added to Favourites
  createdAt: number;
  updatedAt: number;
}

export type UserRole = "admin" | "user";

/** Account managed by the admin (no self-registration). */
export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  color: string | null;
  isActive: boolean;
  createdAt: number;
}

/** Lightweight public user info for attribution display (no secrets). */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  color: string | null;
}

/** A shot/folder inside a project (e.g. "SH07"). */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

/** A production project that organizes generations into folders. */
export interface Project {
  id: string;
  name: string; // "KOK_BORY"
  folders: Folder[];
  brief?: string; // optional free-text project brief
  createdAt: number;
  updatedAt: number;
}

export interface ProjectsResponse {
  projects: Project[];
}

export interface HistoryResponse {
  items: GenerationItem[];
}

/**
 * Reusable, named reference asset used for cross-generation consistency.
 * A character (face), an outfit, a location, a style, or a prop — each holds
 * one or more reference images plus a locked text description. Referenced in a
 * prompt by its @slug (e.g. @priya) and injected into every generation.
 */
export type AssetKind = "character" | "outfit" | "location" | "style" | "prop";

export const ASSET_KINDS: AssetKind[] = [
  "character",
  "outfit",
  "location",
  "style",
  "prop",
];

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string; // "Priya"
  slug: string; // "priya" — unique; used as the @slug tag
  description?: string; // locked physical/style description (reinforces images)
  images: string[]; // public urls (saved to /assets), multiple angles
  createdAt: number;
  updatedAt: number;
}

export interface AssetsResponse {
  assets: Asset[];
}
