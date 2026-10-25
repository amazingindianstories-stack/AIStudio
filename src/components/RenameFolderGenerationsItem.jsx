"use client";

import { Pencil } from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { askConfirm } from "@/lib/ask-text";
import { notify } from "@/lib/notify";
import { MenuItem } from "./Dropdown";

const generations = (count) => `${count} ${count === 1 ? "generation" : "generations"}`;

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
      const example = preview.example ? ` Example: ${preview.example.oldName || "Unassigned"} → ${preview.example.newName}.` : "";
      const skipped = `${generations(preview.skippedCount)} will be skipped${preview.skippedCount ? " because their draft or final lives in another folder" : ""}.`;
      const confirmed = await askConfirm({
        title: `Rename to match "${folder.name}"?`,
        description: `${generations(preview.renamedCount)} in this folder and its subfolders will be renamed. ${skipped}${example} Already downloaded files keep their old names.`,
        confirmLabel: preview.renamedCount ? "Rename generations" : "Close",
      });
      if (!confirmed || !preview.renamedCount) return;
      const result = await rename({ id: folder.id, previewToken: preview.previewToken });
      notify(`Renamed ${generations(result.renamedCount)}. Skipped ${result.skippedCount}${result.skippedCount ? " because their draft or final lives in another folder" : ""}.`);
    } catch (error) {
      notify(error.message || "Failed to rename generations.");
    }
  };
  return <MenuItem onClick={() => void handleRename()}>
    <Pencil className="h-3.5 w-3.5 text-white/50" />
    <span>Rename to match folder</span>
  </MenuItem>;
}
