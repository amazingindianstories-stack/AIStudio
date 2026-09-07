export function generationError(item) {
  const detail = item.error || "No error detail was recorded.";
  if (
    /overdue|balance|billing|payment|credit|api.?key|unauthorized|authentication|credential|account.*(suspend|disable)/i.test(
      detail,
    )
  )
    return {
      category: "Provider account needs attention",
      action:
        "Ask an administrator to check provider access or billing. Changing the prompt will not resolve this account error.",
      detail,
    };
  if (
    item.moderationBlocked ||
    /moderation|content.?policy|safety|invalid.*(prompt|reference)|unsupported.*(input|resolution|duration)/i.test(
      detail,
    )
  )
    return {
      category: "Input needs review",
      action:
        "Review the prompt, references and model requirements before trying again.",
      detail,
    };
  if (
    /timeout|timed out|rate.?limit|429|503|unavailable|network|connection/i.test(
      detail,
    )
  )
    return {
      category: "Temporary provider or connection problem",
      action:
        "Try again later. If this continues, ask an administrator to inspect the job. A retry may incur a new charge.",
      detail,
    };
  return {
    category: "Generation could not finish",
    action:
      "Review the technical details with an administrator before retrying. A retry may incur a new charge.",
    detail,
  };
}
