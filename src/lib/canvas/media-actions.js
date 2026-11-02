/** Media edits use board data and the existing history/per-node save path. */
import { useCanvasStore, selectReadOnly } from '../canvas-store';
import { currentUserId } from './sticky-actions';
import { mediaRef, validateLink } from './media-nodes';
import { mediaNodeFields, importBoardUrl } from './media-upload';
import { objectLink } from './object-link';
import { PROVIDER_NAMES, embedFromIframe, embedFromUrl } from './embeds';

export function addMedia(fields, center) {
  const state = useCanvasStore.getState();
  if (!state.boardId || selectReadOnly(state)) return null;
  const sizes = { code: [480, 300], embed: [480, 300], pdf: [320, 450], video: [480, 300], audio: [360, 110], linkcard: [360, 240], emoji: [100, 100], icon: [80, 80], image: [320, 240] };
  let [w, h] = sizes[fields.type] || sizes.image;
  if (fields.naturalW > 0 && fields.naturalH > 0) h = w * fields.naturalH / fields.naturalW;
  const point = center || state.viewportCenter();
  const node = { id: crypto.randomUUID(), x: point.x - w / 2, y: point.y - h / 2, w, h,
    parentId: null, groupId: null, ...fields };
  state.addNode(node);
  return node.id;
}

export function placeBoardFile(file, center) {
  return addMedia(mediaNodeFields(file), center);
}

export function replaceImage(id, file) {
  const state = useCanvasStore.getState();
  if (selectReadOnly(state) || !state.history.present.nodes.some((n) => n.id === id && n.type === 'image') || !mediaRef(file.url)) return false;
  state.updateNodeFields(id, { src: file.url, naturalW: file.naturalW || undefined, naturalH: file.naturalH || undefined,
    alt: file.name || '', crop: undefined });
  return true;
}

export function toggleAgreement(id) {
  const state = useCanvasStore.getState(), user = currentUserId();
  const node = state.history.present.nodes.find((n) => n.id === id);
  if (!user || selectReadOnly(state) || node?.type !== 'emoji' || !node.interactive) return false;
  const agreed = new Set(node.agreedBy || []);
  if (agreed.has(user)) agreed.delete(user);
  else if (agreed.size < 200) agreed.add(user);
  state.updateNodeFields(id, { agreedBy: [...agreed] });
  return true;
}

export function extractPdfPages(id) {
  const state = useCanvasStore.getState();
  const node = state.history.present.nodes.find((n) => n.id === id && n.type === 'pdf');
  if (!node || selectReadOnly(state)) return [];
  const images = Array.from({ length: node.pages }, (_, page) => ({
    id: crypto.randomUUID(), type: 'image', x: node.x + node.w + 32 + (page % 5) * (node.w + 24),
    y: node.y + Math.floor(page / 5) * (node.h + 24), w: node.w, h: node.h,
    src: `${node.src}.pages/${page + 1}.png`, alt: `${node.name} - page ${page + 1}`,
    aspectLocked: true, parentId: node.parentId, groupId: null,
  }));
  state.editBoard((graph) => ({ ...graph, nodes: [...graph.nodes, ...images] }));
  state.setSelection(images.map((image) => image.id));
  return images.map((image) => image.id);
}

export function setObjectLink(id, raw) {
  const link = raw == null ? null : validateLink(raw);
  if (raw != null && !link) return false;
  const state = useCanvasStore.getState();
  if (selectReadOnly(state)) return false;
  state.updateNodeFields(id, { link: link || undefined });
  return true;
}

export function objectLinkHref(link, boardId = useCanvasStore.getState().boardId) {
  if (link?.url) return link.url;
  if (!link?.boardId && !link?.nodeId) return null;
  // The board's own link: opening it switches to that board and centres the object (`object-link.js`).
  const { pathname, search } = new URL(objectLink('http://board.local', { board: link.boardId || boardId, object: link.nodeId }));
  return `${pathname}${search}`;
}

/** Flipping a PDF page is a board edit (one page shown to everyone), so viewers cannot do it. */
export function setPdfPage(id, page) {
  const state = useCanvasStore.getState();
  const node = state.history.present.nodes.find((n) => n.id === id && n.type === 'pdf');
  if (!node || selectReadOnly(state) || !Number.isInteger(page) || page < 1 || page > node.pages) return false;
  state.updateNodeFields(id, { page });
  return true;
}

export function renameMedia(id, title) {
  const state = useCanvasStore.getState();
  const node = state.history.present.nodes.find((n) => n.id === id);
  if (!node || selectReadOnly(state)) return false;
  const field = node.type === 'pdf' ? 'name' : 'title';
  state.updateNodeFields(id, { [field]: String(title).slice(0, 200) });
  return true;
}

/** Follows an in-board object link, or opens the other board in this tab. */
export function openObjectLink(link) {
  const state = useCanvasStore.getState();
  if (!link) return false;
  if (link.nodeId && (!link.boardId || link.boardId === state.boardId)) return state.focusObject(link.nodeId);
  if (link.boardId) {
    window.location.assign(objectLinkHref(link));
    return true;
  }
  return false;
}

/**
 * Adds what a pasted or typed link or iframe code stands for: a provider embed (decided locally, nothing
 * fetched), a link preview card, or a stored file the server imported. Resolves to the new node id, or throws
 * with a message to show.
 */
export async function addFromLink(text, boardId, center, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('Enter a link or iframe code.');
  const embed = embedFromIframe(input) || embedFromUrl(input);
  if (embed) return addMedia({ type: 'embed', src: embed.src, provider: embed.provider, kind: embed.kind, title: embed.title }, center);
  if (/<iframe\b/i.test(input)) {
    const names = Object.values(PROVIDER_NAMES);
    throw new Error(`This embed is not supported. Paste a ${names.slice(0, -1).join(', ')} or ${names.at(-1)} embed.`);
  }
  const result = await importBoardUrl(input, boardId, options);
  const fields = mediaNodeFields(result);
  return addMedia(fields, center);
}

export function addCodeBlock({ code, language, fontSize = 14, lineNumbers = true }, center) {
  return addMedia({ type: 'code', code, language, fontSize, lineNumbers }, center);
}

export function addEmoji(emoji, { sticker = false, interactive = false } = {}, center) {
  return addMedia({ type: 'emoji', emoji, ...(sticker ? { style: 'sticker' } : {}), ...(interactive ? { interactive: true } : {}) }, center);
}

export function addIcon(icon, color = '#e5e7eb', center) {
  return addMedia({ type: 'icon', icon, color }, center);
}

/** True for text a person pasted that should become a link, embed or imported file instead of text. */
export function looksLikeLink(text) {
  const value = String(text || '').trim();
  return /^https:\/\/[^\s]+$/.test(value) || /^<iframe\b/i.test(value);
}

export function updateCodeBlock(id, { code, language }) {
  const state = useCanvasStore.getState();
  const node = state.history.present.nodes.find((n) => n.id === id && n.type === 'code');
  if (!node || selectReadOnly(state)) return false;
  state.updateNodeFields(id, { code: String(code).slice(0, 20000), language });
  return true;
}
