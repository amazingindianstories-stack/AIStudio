/**
 * Opens the board a notification link (`/?board=&project=&comment=`) names, removing those parameters from the
 * address, then keeps opening the boards the service worker relays from notification clicks. Watched from the
 * page, so a link works from every view. Returns the unsubscribe. A link without `comment` is a board object
 * link (`object-link.js`), which the board view takes itself.
 */
export function watchBoardLinks(win, open) {
  const url = new URL(win.location.href);
  const boardId = url.searchParams.get("board");
  const commentId = url.searchParams.get("comment");
  if (boardId && commentId) {
    const projectId = url.searchParams.get("project");
    for (const name of ["board", "project", "comment"]) url.searchParams.delete(name);
    win.history.replaceState(null, "", url);
    open({ boardId, projectId, commentId });
  }
  const worker = win.navigator.serviceWorker;
  const onMessage = (event) => event.data?.type === "open-board" && open(event.data);
  worker?.addEventListener("message", onMessage);
  return () => worker?.removeEventListener("message", onMessage);
}
