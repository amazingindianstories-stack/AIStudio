/**
 * HTML embeds are static, self-contained pages: no scripts, no self-navigation and no outside
 * requests, matching the board's rule that opening a board never contacts another origin.
 * The frame that shows them is sandboxed with no permissions; this also strips what the
 * sandbox alone would let through (link clicks, meta refresh, nested frames).
 */

export const EMBED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const REMOVED = "script, noscript, meta, base, link, iframe, frame, frameset, object, embed, portal, applet";
const NAVIGATING = new Set(["target", "action", "formaction", "ping", "srcdoc"]);

/** The page to load in an embed frame for stored `html`; `parser` is a DOMParser. */
export function staticEmbedHtml(html, parser = new DOMParser()) {
  const doc = parser.parseFromString(String(html ?? ""), "text/html");
  for (const el of doc.querySelectorAll(REMOVED)) el.remove();
  for (const el of doc.querySelectorAll("animate, set")) if (/href/i.test(el.getAttribute("attributeName") ?? "")) el.remove();
  for (const el of doc.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      const lower = name.toLowerCase();
      const link = lower === "href" || lower === "xlink:href";
      if (lower.startsWith("on") || NAVIGATING.has(lower) || (link && !value.trim().startsWith("#"))) el.removeAttribute(name);
    }
  }
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", EMBED_CSP);
  doc.head.prepend(csp);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
