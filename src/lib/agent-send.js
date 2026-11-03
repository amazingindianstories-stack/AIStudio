/** Agents tab sends that fail after the server saved the user message: a 502 or 504 returning `userMessage`. */

/**
 * State updaters for a failed send, or null when nothing was saved. The saved message replaces the optimistic one and
 * the documents it carried leave the composer, so trying again neither resends nor re-bills them.
 */
export function afterFailedSend({ status, data, optimisticId, sentDocuments }) {
  const saved = (status === 502 || status === 504) && data?.userMessage?.id ? data.userMessage : null;
  if (!saved) return null;
  return {
    messages: (current) => current.map((message) => (message.id === optimisticId ? saved : message)),
    documents: (current) => current.filter((document) => !sentDocuments.includes(document)),
  };
}
