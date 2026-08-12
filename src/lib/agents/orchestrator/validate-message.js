export const MAX_CONTENT_LEN = 8000;
export const MAX_IMAGES = 4;

 

/** Pure validation for POST /api/agent-conversations/[id]/messages's body,
 *  split out so it's testable without a NextRequest/DB — same reasoning as
 *  route-handler.ts's parseMessages. */
export function parseMessageBody(body) {
  const b = (body && typeof body === "object" ? body : {}) ;
  const content = typeof b.content === "string" ? b.content.trim() : "";
  if (!content) return { error: "content is required." };
  if (content.length > MAX_CONTENT_LEN) {
    return { error: `Message is too long (max ${MAX_CONTENT_LEN} characters).` };
  }

  const raw = b.images;
  if (raw !== undefined && !Array.isArray(raw)) {
    return { error: "images must be an array of data URLs." };
  }
  const images = Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
  if (images.length > MAX_IMAGES) {
    return { error: `Attach at most ${MAX_IMAGES} reference images per message.` };
  }

  return { content, images };
}
