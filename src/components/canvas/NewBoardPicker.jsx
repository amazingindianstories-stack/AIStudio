"use client";

import { TemplatePicker } from "./TemplatePicker";

/** The picker for starting a new board: a template (pre-filled or blank) or a blank board. */
export function NewBoardPicker({ projectId, onStart, onClose }) {
  return (
    <TemplatePicker
      mode="new"
      projectId={projectId}
      onUse={(template, blank) => onStart({ id: template.id, name: template.name, blank })}
      onBlank={() => onStart(null)}
      onBlueprintMade={onClose}
      onEdit={() => {}}
      onEditContent={() => {}}
      onClose={onClose}
    />
  );
}
