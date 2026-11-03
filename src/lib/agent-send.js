/** Agents tab sends that fail: a 502 or 504 returning `userMessage` saved it, anything else saved nothing. */

/**
 * State updaters for a failed send. When the server saved the user message, the saved message replaces the optimistic
 * one and the documents it carried leave the composer, so trying again neither resends nor re-bills them. When nothing
 * was saved, the optimistic message leaves the thread and the documents stay staged for a retry.
 */
export function afterFailedSend({ status, data, optimisticId, sentDocuments }) {
  const saved = (status === 502 || status === 504) && data?.userMessage?.id ? data.userMessage : null;
  if (!saved) {
    return {
      messages: (current) => current.filter((message) => message.id !== optimisticId),
      documents: (current) => current,
    };
  }
  return {
    messages: (current) => current.map((message) => (message.id === optimisticId ? saved : message)),
    documents: (current) => current.filter((document) => !sentDocuments.includes(document)),
  };
}
