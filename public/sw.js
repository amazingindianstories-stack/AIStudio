// Shows a browser notification when the server pushes. Pushes carry no content: this asks the signed-in
// API for the newest unread notification and shows that. Clicking it opens the app on that board.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let item = null;
      try {
        const response = await fetch("/api/notifications?unread=1", { credentials: "same-origin", cache: "no-store" });
        if (response.ok) item = (await response.json()).notifications?.[0] ?? null;
      } catch {
        // Offline or signed out: fall back to the generic text below.
      }
      const verb = item?.kind === "mention" ? "mentioned you" : item?.kind === "reply" ? "replied to a thread you follow" : "commented";
      await self.registration.showNotification(item ? `Someone ${verb}` : "New activity on a board", {
        body: item ? `${item.snippet || ""}${item.boardName ? ` (${item.boardName})` : ""}`.trim() : "Open Veevee to see it.",
        tag: item ? `board-${item.boardId}` : "veevee-activity",
        data: item ? { boardId: item.boardId, projectId: item.projectId, commentId: item.threadId ?? item.commentId } : {},
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { boardId, projectId, commentId } = event.notification.data || {};
  const params = new URLSearchParams();
  if (boardId) params.set("board", boardId);
  if (projectId) params.set("project", projectId);
  if (commentId) params.set("comment", commentId);
  const target = `/${params.size ? `?${params}` : ""}`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
        open.postMessage({ type: "open-board", boardId, projectId, commentId });
      } else {
        await self.clients.openWindow(target);
      }
    })()
  );
});
