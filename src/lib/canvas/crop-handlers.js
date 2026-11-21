import { useCanvasStore } from "@/lib/canvas-store";

export const onCropChange = (patch) => useCanvasStore.getState().updateCropDraft(patch);
export const onApplyCrop = () => useCanvasStore.getState().applyCrop();
export const onCancelCrop = () => useCanvasStore.getState().cancelCrop();
export const onResetCrop = () => useCanvasStore.getState().resetCropDraft();
