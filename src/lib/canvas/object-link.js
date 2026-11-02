/**
 * Links to one object or frame on a board: `/?project=P&board=B&object=O`.
 * Opening one switches to the board view, opens that board and centers the
 * object, with a "Go back" prompt to return to where the view was.
 */

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PARAMS = ["project", "board", "object"];

/** The link for `object` on `board` in `project`, absolute against `origin`. */
export function objectLink(origin, { project, board, object }) {
  const url = new URL("/", origin);
  if (project) url.searchParams.set("project", project);
  url.searchParams.set("board", board);
  if (object) url.searchParams.set("object", object);
  return url.toString();
}

/** `{project, board, object}` from a URL's search string; null unless it names a board. */
export function parseObjectLink(search) {
  const params = new URLSearchParams(search);
  const board = params.get("board");
  if (!board || !ID.test(board)) return null;
  const pick = (key) => {
    const value = params.get(key);
    return value && ID.test(value) ? value : null;
  };
  return { project: pick("project"), board, object: pick("object") };
}

/** `href` without the link's parameters, for replacing the address once the link is opened. */
export function withoutLinkParams(href) {
  const url = new URL(href);
  for (const key of PARAMS) url.searchParams.delete(key);
  return url.toString();
}

/** The link the page was opened with, read once in the browser. */
export function pageObjectLink() {
  if (typeof window === "undefined") return null;
  return parseObjectLink(window.location.search);
}
