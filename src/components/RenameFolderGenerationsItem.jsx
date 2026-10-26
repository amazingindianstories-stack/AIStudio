"use client";

import { Pencil } from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { askConfirm } from "@/lib/ask-text";
import { notify } from "@/lib/notify";
import { MenuItem } from "./Dropdown";

const generations = (count) => `${count} ${count === 1 ? "generation" : "generations"}`;
const SKIP_REASON = " because their draft or final lives in another folder";

export function RenameFolderGenerationsItem({ folder, close }) {
  const isAdmin = useStore((state) => state.currentUser?.role === "admin");
  const rename = useStore((state) => state.renameFolderGenerations);
  if (!isAdmin) return null;
  const handleRename = async () => {
    close();
    try {
      const response = await apiFetch(`/api/folders?renamePreview=${encodeURIComponent(folder.id)}`);
      const preview = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(preview, response.status, "Failed to preview names"));
      if (!preview.renamedCount) {
        notify(`No generations in "${folder.name}" need renaming.${preview.skippedCount ? ` Skipped ${generations(preview.skippedCount)}${SKIP_REASON}.` : ""}`, { tone: "info" });
        return;
      }
      const example = preview.example ? ` Example: ${preview.example.oldName} → ${preview.example.newName}.` : "";
      const skipped = `${generations(preview.skippedCount)} will be skipped${preview.skippedCount ? SKIP_REASON : ""}.`;
      const confirmed = await askConfirm({
        title: `Rename to match "${folder.name}"?`,
        description: `${generations(preview.renamedCount)} in this folder and its subfolders will be renamed. ${skipped}${example} Already downloaded files keep their old names.`,
        confirmLabel: "Rename generations",
      });
      if (!confirmed) return;
      const result = await rename({ id: folder.id, previewToken: preview.previewToken });
      notify(`Renamed ${generations(result.renamedCount)}.${result.skippedCount ? ` Skipped ${generations(result.skippedCount)}${SKIP_REASON}.` : ""}`, { tone: "info" });
    } catch (error) {
      notify(error.message || "Failed to rename generations.");
    }
  };
  return <MenuItem onClick={() => void handleRename()}>
    <Pencil className="h-3.5 w-3.5 text-white/50" />
    <span>Rename to match folder</span>
  </MenuItem>;
}
