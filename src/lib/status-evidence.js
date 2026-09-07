export function statusEvidence(check) {
  if (check.status !== "ok")
    return {
      label: check.status === "error" ? "Check failed" : "Not verified",
      kind: check.status,
    };
  if (
    ["seedance", "kling", "omni"].includes(check.id) ||
    /config.presence/i.test(check.detail || "")
  )
    return { label: "Configured · not tested", kind: "configured" };
  if (check.id === "higgsfield")
    return { label: "Cached token fresh", kind: "cached" };
  if (check.id === "gemini")
    return { label: "Service reachable", kind: "reachable" };
  return { label: "Check passed", kind: "checked" };
}
