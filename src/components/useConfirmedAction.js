import { useCallback, useMemo, useState } from "react";
import { mediaActionCopy } from "@/lib/media-action-confirmation";

export function useConfirmedAction() {
  const [request, setRequest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = useCallback((kind, run) => {
    setError("");
    setBusy(false);
    setRequest({ kind, run });
  }, []);

  const cancel = useCallback(() => {
    if (busy) return;
    setRequest(null);
    setError("");
  }, [busy]);

  const confirm = useCallback(async () => {
    if (!request || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await request.run();
      if (result === false || result?.ok === false) {
        throw new Error(result?.error || "The action could not be completed.");
      }
      setRequest(null);
    } catch (actionError) {
      setError(actionError?.message || "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }, [busy, request]);

  const dialogProps = useMemo(() => {
    const copy = request ? mediaActionCopy(request.kind) : {};
    return {
      open: Boolean(request),
      ...copy,
      busy,
      error,
      onCancel: cancel,
      onConfirm: confirm,
    };
  }, [busy, cancel, confirm, error, request]);

  return { ask, dialogProps };
}
