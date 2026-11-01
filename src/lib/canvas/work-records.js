/** Shared field/record/view vocabulary for cards and data-backed work widgets. */
import { inFreeSpace } from './ai-formats';

export const WORK_KINDS = ['columns', 'table', 'kanban', 'timeline', 'story', 'mindmap', 'org', 'chart'];
export const FIELD_TYPES = ['text', 'number', 'select', 'date', 'people', 'points', 'formula', 'relation'];
export const WORK_VIEW_NAMES = { table: 'Table', kanban: 'Kanban', timeline: 'Timeline', story: 'Story map', mindmap: 'Mind map', org: 'Org chart', chart: 'Chart' };
export function viewFor(table, kind) {
  return table?.views.find(v => v.kind === kind) || { id: kind, kind, name: WORK_VIEW_NAMES[kind] };
}
/** Every record a record waits on: explicit dependencies plus the targets of its relation fields. */
export function blockersOf(record, fields) {
  return [...new Set([...(record.blockedBy || []), ...fields.filter(f => f.type === 'relation').flatMap(f => Array.isArray(record.cells[f.id]) ? record.cells[f.id] : [])])];
}
export const DEFAULT_FIELDS = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'description', name: 'Description', type: 'text' },
  { id: 'assignee', name: 'Assignee', type: 'people' },
  { id: 'start', name: 'Start date', type: 'date' },
  { id: 'end', name: 'End date', type: 'date' },
  { id: 'status', name: 'Status', type: 'select', options: ['To do', 'In progress', 'Done'] },
  { id: 'tags', name: 'Tags', type: 'text' },
  { id: 'links', name: 'Links', type: 'text' },
];
const string = (v, n = 2000) => typeof v === 'string' ? v.slice(0, n) : '';
export function cleanRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const [key, value] of Object.entries(r).slice(0, 64)) {
    if (!/^[\w-]{1,64}$/.test(key)) continue;
    if (typeof value === 'string') result[key] = string(value);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (Array.isArray(value)) result[key] = value.filter(v => typeof v === 'string').slice(0, 64).map(v => string(v, 128));
  }
  return result;
}
export function cleanLanes(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 30).filter(v => v && typeof v.id === 'string').map(v => ({ id: string(v.id, 64), name: string(v.name, 120), color: /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : '#dbeafe' }));
}
export function cleanWorkNode(r) {
  if (r.type === 'card') return { record: cleanRecord(r.record) };
  return {
    kind: WORK_KINDS.includes(r.kind) ? r.kind : 'table',
    title: string(r.title, 120),
    ...(typeof r.datasetId === 'string' ? { datasetId: string(r.datasetId, 64) } : {}),
    ...(r.kind === 'columns' ? { lanes: cleanLanes(r.lanes), swimlanes: cleanLanes(r.swimlanes) } : {}),
  };
}
export function newCard(point, record = {}) {
  return { id: crypto.randomUUID(), type: 'card', x: point.x, y: point.y, w: 280, h: 170, parentId: null, groupId: null,
    record: { title: 'Untitled task', status: 'To do', ...cleanRecord(record) } };
}
export function newColumns(point) {
  return { id: crypto.randomUUID(), type: 'work', kind: 'columns', title: 'Team board', x: point.x, y: point.y, w: 960, h: 560,
    parentId: null, groupId: null, lanes: ['To do', 'In progress', 'Done'].map(name => ({ id: crypto.randomUUID(), name, color: '#dbeafe' })),
    swimlanes: [{ id: crypto.randomUUID(), name: 'Team', color: '#f1f5f9' }] };
}
/** `node` centred on `point`, or moved to the nearest free board space so it never lands on existing `nodes`. */
export function placeWorkNode(node, point, nodes) {
  return inFreeSpace([{ ...node, x: point.x - node.w / 2, y: point.y - node.h / 2 }], nodes)[0];
}
/** `card` filed under the lane and swimlane of the `columns` cell its center sits in. */
export function inColumnsCell(card, columns) {
  if (!columns.lanes.length || !columns.swimlanes.length) return card;
  const index = (offset, size, count) => Math.min(count - 1, Math.max(0, Math.floor(offset / size)));
  const lane = index(card.x + card.w / 2 - columns.x - 10, (columns.w - 20) / columns.lanes.length, columns.lanes.length);
  const row = index(card.y + card.h / 2 - columns.y - 72, (columns.h - 72) / columns.swimlanes.length, columns.swimlanes.length);
  return { ...card, record: { ...card.record, lane: columns.lanes[lane].id, swimlane: columns.swimlanes[row].id } };
}
/** Compute every card position from board data, including off-screen cards. */
export function layoutColumns(board, columnId) {
  const container = board.nodes.find(n => n.id === columnId && n.kind === 'columns');
  if (!container || !container.lanes.length || !container.swimlanes.length) return board;
  const width = (container.w - 20) / container.lanes.length;
  const cells = new Map(), offsets = new Map();
  for (const n of board.nodes) {
    if (n.type !== 'card' || n.parentId !== columnId) continue;
    const laneIndex = Math.max(0, container.lanes.findIndex(v => v.id === n.record.lane));
    const rowIndex = Math.max(0, container.swimlanes.findIndex(v => v.id === n.record.swimlane));
    const key = `${laneIndex}:${rowIndex}`;
    const offset = offsets.get(key) || 0;
    offsets.set(key, offset + n.h + 14);
    cells.set(n.id, { laneIndex, rowIndex, offset });
  }
  const height = Math.max((container.h - 72) / container.swimlanes.length, 12 + Math.max(0, ...offsets.values()));
  return { ...board, nodes: board.nodes.map(n => {
    if (n.id === columnId) return { ...n, h: 72 + height * container.swimlanes.length };
    const cell = cells.get(n.id);
    if (!cell) return n;
    return { ...n, x: container.x + 16 + cell.laneIndex * width, y: container.y + 84 + cell.rowIndex * height + cell.offset,
      w: Math.max(100, width - 20), record: { ...n.record, lane: container.lanes[cell.laneIndex].id, swimlane: container.swimlanes[cell.rowIndex].id } };
  }) };
}
