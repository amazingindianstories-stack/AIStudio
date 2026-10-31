import { treeLayout } from './work-layouts';
import { inFreeSpace } from './ai-formats';

const COLORS = ['#dbeafe', '#fce7f3', '#dcfce7', '#fef3c7', '#ede9fe'];
function box(point, w, h, extra) {
  return { id: crypto.randomUUID(), x: point.x, y: point.y, w, h, parentId: null, groupId: null, ...extra };
}
export function treeToBoard(board, records, view, origin, kind = 'mindmap') {
  const placed = treeLayout(records, { collapsed: view.collapsed });
  const ids = new Map(placed.map(r => [r.id, crypto.randomUUID()]));
  const nodes = placed.map(r => ({ ...box({ x: origin.x + r.x, y: origin.y + r.y }, 210, 80, { type: view.nodeType === 'ellipse' ? 'ellipse' : 'rect',
    fill: view.branchColor || COLORS[r.branch % COLORS.length], stroke: '#64748b', strokeWidth: 1, cornerRadius: view.nodeType === 'shape' ? 24 : 8,
    text: String(r.cells.title || 'Untitled') + (kind === 'org' ? '\n' + Object.entries(r.cells).filter(([key]) => key !== 'title' && !view.hiddenFields?.includes(key)).slice(0, 2).map(([, value]) => value).join('\n') : ''),
    fontSize: 14, color: '#0f172a', align: 'center' }), id: ids.get(r.id) }));
  const connectors = placed.filter(r => ids.has(r.parentId)).map(r => ({ id: crypto.randomUUID(), from: { nodeId: ids.get(r.parentId), anchor: 'right' }, to: { nodeId: ids.get(r.id), anchor: 'left' }, kind: 'line', shape: 'orthogonal', stroke: '#64748b', strokeWidth: 2 }));
  return { ...board, nodes: [...board.nodes, ...nodes], connectors: [...board.connectors, ...connectors] };
}
/** A timeline frame starting at `origin`, moved to the nearest free board space. */
export function buildTimeline(board, { start, end, interval = 'month', lanes, color = '#dbeafe' }, origin) {
  const a = Date.parse(start + 'T00:00:00Z'), b = Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) throw new Error('Choose valid start and end dates in order.');
  const rows = lanes.split('\n').map(v => v.trim()).filter(Boolean).slice(0, 20);
  if (!rows.length) throw new Error('Add at least one swimlane.');
  const periods = []; let cursor = new Date(a);
  while (cursor.getTime() <= b) {
    if (periods.length >= 120) throw new Error('Use a larger interval. A timeline can contain up to 120 periods.');
    periods.push(cursor.toISOString().slice(0, 10));
    if (interval === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (interval === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
    else { const day = cursor.getUTCDate(); cursor.setUTCDate(1); cursor.setUTCMonth(cursor.getUTCMonth() + (interval === 'quarter' ? 3 : 1)); const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate(); cursor.setUTCDate(Math.min(day, last)); }
  }
  const frame = box(origin, 160 + periods.length * 140, 100 + rows.length * 100, { type: 'frame', name: `Timeline ${start} to ${end}`, fill: '#ffffff', stroke: '#cbd5e1' });
  const nodes = [frame];
  function label(text, x, y, w, h, fill) {
    nodes.push(box({ x, y }, w, h, { type: 'rect', parentId: frame.id, fill, stroke: '#cbd5e1', strokeWidth: 1, text, fontSize: 14, color: '#0f172a', align: 'center' }));
  }
  periods.forEach((date, column) => label(date, origin.x + 150 + column * 140, origin.y + 40, 140, 40, color));
  rows.forEach((name, row) => {
    label(name, origin.x + 10, origin.y + 80 + row * 100, 140, 100, '#f1f5f9');
    periods.forEach((_, column) => label('', origin.x + 150 + column * 140, origin.y + 80 + row * 100, 140, 100, '#ffffff'));
  });
  return { ...board, nodes: [...board.nodes, ...inFreeSpace(nodes, board.nodes)] };
}
