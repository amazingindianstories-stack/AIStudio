import { useRef, useCallback, useState } from "react";

/**
 * React hook to eliminate HTML5 drag-and-drop nested-child dragleave flicker.
 *
 * Keeps an enter/leave reference counter so moving between nested child DOM elements
 * inside a dropzone container never triggers premature dragleave cancellation.
 *
 * @param {Object} options
 * @param {function(DragEvent): { valid: boolean, reason?: string }} [options.onValidate]
 * @param {function(boolean, DragEvent): void} [options.onActiveChange]
 * @param {"copy"|"move"|"none"} [options.defaultDropEffect="copy"]
 */
export function useDropzoneGuard({
  onValidate,
  onActiveChange,
  defaultDropEffect = "copy",
} = {}) {
  const counterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isValid, setIsValid] = useState(true);
  const [validationReason, setValidationReason] = useState("");

  const handleDragEnter = useCallback(
    (e) => {
      counterRef.current += 1;
      if (counterRef.current === 1) {
        setIsDragging(true);
        if (onValidate) {
          const res = onValidate(e);
          setIsValid(res.valid);
          setValidationReason(res.reason || "");
        } else {
          setIsValid(true);
          setValidationReason("");
        }
        onActiveChange?.(true, e);
      }
    },
    [onValidate, onActiveChange]
  );

  const handleDragOver = useCallback(
    (e) => {
      e.preventDefault();
      let currentValid = isValid;
      if (onValidate) {
        const res = onValidate(e);
        currentValid = res.valid;
        if (res.valid !== isValid) setIsValid(res.valid);
        if (res.reason !== validationReason) setValidationReason(res.reason || "");
      }
      e.dataTransfer.dropEffect = currentValid ? defaultDropEffect : "none";
    },
    [isValid, validationReason, onValidate, defaultDropEffect]
  );

  const handleDragLeave = useCallback(
    (e) => {
      counterRef.current = Math.max(0, counterRef.current - 1);
      if (counterRef.current === 0) {
        setIsDragging(false);
        setIsValid(true);
        setValidationReason("");
        onActiveChange?.(false, e);
      }
    },
    [onActiveChange]
  );

  const handleDrop = useCallback(
    (e) => {
      counterRef.current = 0;
      setIsDragging(false);
      setIsValid(true);
      setValidationReason("");
      onActiveChange?.(false, e);
    },
    [onActiveChange]
  );

  const reset = useCallback(() => {
    counterRef.current = 0;
    setIsDragging(false);
    setIsValid(true);
    setValidationReason("");
    onActiveChange?.(false);
  }, [onActiveChange]);

  return {
    isDragging,
    isValid,
    validationReason,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    reset,
    counterRef,
  };
}
