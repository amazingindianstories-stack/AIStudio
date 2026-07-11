"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Camera,
  CheckCircle2,
  KeyRound,
  Loader2,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AccountUser {
  id: string;
  email: string;
  name: string;
  color: string | null;
  avatarUrl?: string | null;
}

interface AccountSettingsProps {
  open: boolean;
  user: AccountUser;
  onClose: () => void;
  onUserUpdated: (user: AccountUser) => void | Promise<void>;
}

type Tab = "profile" | "security";
type Notice = { kind: "success" | "error"; text: string } | null;

const inputClass =
  "w-full rounded-lg border border-line bg-ink-700 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:cursor-not-allowed disabled:opacity-55";

async function responseJson(response: Response) {
  return response.json().catch(() => ({}));
}

export function AccountSettings({
  open,
  user,
  onClose,
  onUserUpdated,
}: AccountSettingsProps) {
  const [tab, setTab] = useState<Tab>("profile");
  const [name, setName] = useState(user.name);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    user.avatarUrl ?? null
  );
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<Notice>(null);
  const [passwords, setPasswords] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    profile: null,
    security: null,
  });
  const titleId = useId();
  const profileTabId = useId();
  const profilePanelId = useId();
  const securityTabId = useId();
  const securityPanelId = useId();

  useEffect(() => {
    if (!open) return;
    setTab("profile");
    setName(user.name);
    setAvatarPreview(user.avatarUrl ?? null);
    setAvatarFile(null);
    setAvatarRemoved(false);
    setProfileNotice(null);
    setPasswords({ current: "", next: "", confirm: "" });
    setPasswordNotice(null);
  }, [open, user.avatarUrl, user.name]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  const selectTab = (nextTab: Tab) => {
    setTab(nextTab);
    if (nextTab === "security") {
      requestAnimationFrame(() => currentPasswordRef.current?.focus());
    }
  };

  const moveTabFocus = (currentTab: Tab, key: string) => {
    const tabs: Tab[] = ["profile", "security"];
    const currentIndex = tabs.indexOf(currentTab);
    const nextTab =
      key === "Home"
        ? tabs[0]
        : key === "End"
        ? tabs[tabs.length - 1]
        : key === "ArrowLeft" || key === "ArrowUp"
        ? tabs[(currentIndex - 1 + tabs.length) % tabs.length]
        : key === "ArrowRight" || key === "ArrowDown"
        ? tabs[(currentIndex + 1) % tabs.length]
        : null;
    if (!nextTab) return;
    selectTab(nextTab);
    requestAnimationFrame(() => tabRefs.current[nextTab]?.focus());
  };

  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProfileNotice({ kind: "error", text: "Choose a valid image file." });
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setProfileNotice({ kind: "error", text: "Profile pictures must be 3 MB or smaller." });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAvatarPreview(String(reader.result));
      setAvatarFile(file);
      setAvatarRemoved(false);
      setProfileNotice(null);
    };
    reader.onerror = () =>
      setProfileNotice({ kind: "error", text: "That image could not be read." });
    reader.readAsDataURL(file);
  };

  const removeAvatar = () => {
    setAvatarPreview(null);
    setAvatarFile(null);
    setAvatarRemoved(true);
    setProfileNotice(null);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setProfileNotice({ kind: "error", text: "Name cannot be empty." });
      return;
    }
    if (trimmedName.length > 80) {
      setProfileNotice({ kind: "error", text: "Name must be 80 characters or fewer." });
      return;
    }

    setProfileBusy(true);
    setProfileNotice(null);
    try {
      let body: BodyInit;
      let headers: HeadersInit | undefined;
      if (avatarFile) {
        const form = new FormData();
        form.set("name", trimmedName);
        form.set("avatar", avatarFile);
        body = form;
      } else {
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify({
          name: trimmedName,
          ...(avatarRemoved ? { avatar: null } : {}),
        });
      }

      const response = await fetch("/api/auth/me", { method: "PATCH", headers, body });
      const json = await responseJson(response);
      if (!response.ok) throw new Error(json.error || "Could not update your profile.");

      const updated = json.user as AccountUser;
      setName(updated.name);
      setAvatarPreview(updated.avatarUrl ?? null);
      setAvatarFile(null);
      setAvatarRemoved(false);
      await onUserUpdated(updated);
      setProfileNotice({ kind: "success", text: "Profile updated." });
    } catch (error) {
      setProfileNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not update your profile.",
      });
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwords.current || !passwords.next) {
      setPasswordNotice({ kind: "error", text: "Enter your current and new password." });
      return;
    }
    if (passwords.next !== passwords.confirm) {
      setPasswordNotice({ kind: "error", text: "New passwords do not match." });
      return;
    }
    if (passwords.next.length < 8 || passwords.next.length > 128) {
      setPasswordNotice({
        kind: "error",
        text: "New password must be between 8 and 128 characters.",
      });
      return;
    }

    setPasswordBusy(true);
    setPasswordNotice(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.next,
        }),
      });
      const json = await responseJson(response);
      if (!response.ok) throw new Error(json.error || "Could not change your password.");

      setPasswords({ current: "", next: "", confirm: "" });
      setPasswordNotice({ kind: "success", text: "Password changed." });
    } catch (error) {
      setPasswordNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not change your password.",
      });
    } finally {
      setPasswordBusy(false);
    }
  };

  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();
  const profileDirty =
    name.trim() !== user.name ||
    Boolean(avatarFile) ||
    (avatarRemoved && Boolean(user.avatarUrl));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] grid place-items-end bg-black/65 p-0 backdrop-blur-sm sm:place-items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-800 shadow-pop sm:max-w-xl sm:rounded-2xl"
            initial={{ opacity: 0, y: 28, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 22, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 390, damping: 36 }}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4 sm:px-5">
              <div>
                <h2 id={titleId} className="text-sm font-semibold text-white">
                  Account settings
                </h2>
                <p className="text-xs text-white/40">{user.email}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg text-white/55 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                aria-label="Close account settings"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex shrink-0 gap-1 border-b border-line px-4 pt-2 sm:px-5" role="tablist">
              {(
                [
                  ["profile", "Profile", UserRound],
                  ["security", "Security", KeyRound],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  ref={(element) => {
                    tabRefs.current[id] = element;
                  }}
                  id={id === "profile" ? profileTabId : securityTabId}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={id === "profile" ? profilePanelId : securityPanelId}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => selectTab(id)}
                  onKeyDown={(event) => {
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      moveTabFocus(id, event.key);
                    }
                  }}
                  className={cn(
                    "relative flex items-center gap-2 px-3 py-2.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30",
                    tab === id ? "text-white" : "text-white/45 hover:text-white/75"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                  {tab === id && (
                    <motion.span
                      layoutId="account-settings-tab"
                      className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-white"
                    />
                  )}
                </button>
              ))}
            </div>

            <div className="scroll-thin min-h-0 overflow-y-auto p-4 sm:p-5">
              <AnimatePresence mode="wait" initial={false}>
                {tab === "profile" ? (
                  <motion.form
                    key="profile"
                    id={profilePanelId}
                    role="tabpanel"
                    aria-labelledby={profileTabId}
                    onSubmit={saveProfile}
                    initial={{ opacity: 0, x: -14 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -14 }}
                    transition={{ duration: 0.18 }}
                    className="space-y-5"
                  >
                    <div className="flex flex-wrap items-center gap-4">
                      <span
                        className="relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full text-xl font-semibold text-ink-900 ring-1 ring-white/15"
                        style={{ background: user.color || "#34d399" }}
                      >
                        {initial}
                        {avatarPreview && (
                          <img
                            src={avatarPreview}
                            alt="Profile preview"
                            className="absolute inset-0 h-full w-full object-cover"
                          />
                        )}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={chooseAvatar}
                          className="sr-only"
                          aria-label="Choose profile picture"
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-2 rounded-lg border border-lineStrong bg-ink-700 px-3 py-2 text-sm text-white/75 transition hover:border-white/20 hover:text-white"
                        >
                          <Camera className="h-4 w-4" />
                          Choose photo
                        </button>
                        {(avatarPreview || (user.avatarUrl && !avatarRemoved)) && (
                          <button
                            type="button"
                            onClick={removeAvatar}
                            className="grid h-9 w-9 place-items-center rounded-lg text-white/45 transition hover:bg-red-500/10 hover:text-red-300"
                            aria-label="Remove profile picture"
                            title="Remove profile picture"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        <p className="basis-full text-xs text-white/35">PNG, JPG, WebP or GIF, up to 3 MB.</p>
                      </div>
                    </div>

                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-white/60">Name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="name"
                        maxLength={80}
                        className={inputClass}
                        disabled={profileBusy}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-white/60">Email</span>
                      <input
                        value={user.email}
                        readOnly
                        aria-readonly="true"
                        className={cn(inputClass, "cursor-not-allowed text-white/45")}
                      />
                    </label>

                    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                      <NoticeLine notice={profileNotice} />
                      <button
                        type="submit"
                        disabled={profileBusy || !name.trim() || !profileDirty}
                        className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {profileBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Save changes
                      </button>
                    </div>
                  </motion.form>
                ) : (
                  <motion.form
                    key="security"
                    id={securityPanelId}
                    role="tabpanel"
                    aria-labelledby={securityTabId}
                    onSubmit={changePassword}
                    initial={{ opacity: 0, x: 14 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 14 }}
                    transition={{ duration: 0.18 }}
                    className="space-y-4"
                  >
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-white/60">Current password</span>
                      <input
                        ref={currentPasswordRef}
                        type="password"
                        value={passwords.current}
                        onChange={(event) =>
                          setPasswords((value) => ({ ...value, current: event.target.value }))
                        }
                        autoComplete="current-password"
                        className={inputClass}
                        disabled={passwordBusy}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-white/60">New password</span>
                      <input
                        type="password"
                        value={passwords.next}
                        onChange={(event) =>
                          setPasswords((value) => ({ ...value, next: event.target.value }))
                        }
                        autoComplete="new-password"
                        className={inputClass}
                        disabled={passwordBusy}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-white/60">Confirm new password</span>
                      <input
                        type="password"
                        value={passwords.confirm}
                        onChange={(event) =>
                          setPasswords((value) => ({ ...value, confirm: event.target.value }))
                        }
                        autoComplete="new-password"
                        className={inputClass}
                        disabled={passwordBusy}
                      />
                    </label>

                    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                      <NoticeLine notice={passwordNotice} />
                      <button
                        type="submit"
                        disabled={passwordBusy || !passwords.current || !passwords.next || !passwords.confirm}
                        className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {passwordBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Change password
                      </button>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-5 items-center gap-1.5 text-xs",
        notice?.kind === "error" ? "text-red-300" : "text-emerald-300"
      )}
    >
      {notice?.kind === "success" && <CheckCircle2 className="h-3.5 w-3.5" />}
      {notice?.text}
    </span>
  );
}
