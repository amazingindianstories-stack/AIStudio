/** Media edits use board data and the existing history/per-node save path. */
import { useCanvasStore, selectReadOnly } from '../canvas-store';
import { currentUserId } from './sticky-actions';
import { mediaRef, validateLink } from './media-nodes';
import { mediaNodeFields } from './media-upload';

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

export function objectLinkHref(link, boardId) {
  if (link?.url) return link.url;
  if (!link?.boardId && !link?.nodeId) return null;
  const params = new URLSearchParams({ board: link.boardId || boardId });
  if (link.nodeId) params.set('object', link.nodeId);
  return `#${params}`;
}
