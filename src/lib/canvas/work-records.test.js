import test from 'node:test';
import assert from 'node:assert/strict';
import { newCard, newColumns, layoutColumns, cleanRecord, viewFor, blockersOf, placeWorkNode, inColumnsCell } from './work-records.js';
import { validateCanvasState, emptyCanvasState } from './serialization.js';
import { useCanvasStore } from '../canvas-store.js';

test('work records round trip and reject unsafe or unbounded values', () => {
  const card = newCard({ x: -10000, y: 12000 }, { title: 'Build', description: 'Details', assignee: 'actor', start: '2026-10-01', end: '2026-10-31', tags: 'team', links: 'https://example.test' });
  assert.deepEqual(validateCanvasState({ nodes: [card] }).nodes, [card]);
  assert.deepEqual(cleanRecord({ bad: {}, number: Infinity, ok: 5, long: 'x'.repeat(3000) }), { ok: 5, long: 'x'.repeat(2000) });
});
test('columns lay out offscreen cards using lanes and swimlanes from data', () => {
  const columns = newColumns({ x: 10000, y: 10000 });
  const a = { ...newCard({ x: 0, y: 0 }), parentId: columns.id };
  const b = { ...newCard({ x: 0, y: 0 }), parentId: columns.id, record: { title: 'B', lane: columns.lanes[2].id } };
  const board = layoutColumns({ nodes: [columns, a, b] }, columns.id);
  assert.equal(board.nodes[1].x, 10016);
  assert.ok(board.nodes[2].x > board.nodes[1].x);
  assert.equal(board.nodes[1].record.swimlane, columns.swimlanes[0].id);
  assert.deepEqual(validateCanvasState(board).nodes, board.nodes);
});
test('columns grow so every card in a crowded cell stays inside its swimlane', () => {
  const columns = { ...newColumns({ x: 0, y: 0 }), swimlanes: [{ id: 'top', name: 'Top', color: '#f1f5f9' }, { id: 'bottom', name: 'Bottom', color: '#f1f5f9' }] };
  const cards = Array.from({ length: 4 }, (_, i) => ({ ...newCard({ x: 0, y: 0 }), parentId: columns.id, record: { title: `Card ${i}`, lane: columns.lanes[0].id, swimlane: 'top' } }));
  const lower = { ...newCard({ x: 0, y: 0 }), parentId: columns.id, record: { title: 'Lower', lane: columns.lanes[1].id, swimlane: 'bottom' } };
  const board = layoutColumns({ nodes: [columns, ...cards, lower] }, columns.id);
  const [container, ...placed] = board.nodes;
  const row = (container.h - 72) / 2;
  assert.ok(container.h > columns.h);
  for (const card of placed.slice(0, 4)) assert.ok(card.y >= container.y + 72 && card.y + card.h <= container.y + 72 + row, card.record.title);
  for (let i = 1; i < 4; i++) assert.ok(placed[i].y >= placed[i - 1].y + placed[i - 1].h);
  assert.equal(placed[4].y, container.y + 84 + row);
  assert.ok(placed[4].y + placed[4].h <= container.y + container.h);
  const roomy = layoutColumns({ nodes: [columns, lower] }, columns.id);
  assert.equal(roomy.nodes[0].h, columns.h);
});
test('new work widgets centre on the viewport and never stack on existing board content', () => {
  const center = { x: 1000, y: 500 };
  const first = placeWorkNode(newColumns({ x: 0, y: 0 }), center, []);
  assert.deepEqual([first.x, first.y], [520, 220]);
  const nodes = [first];
  for (let i = 0; i < 3; i++) nodes.push(placeWorkNode({ id: `w${i}`, type: 'work', kind: 'chart', x: 0, y: 0, w: 640, h: 420 }, center, nodes));
  nodes.push(placeWorkNode(newCard({ x: 0, y: 0 }), center, nodes));
  const apart = (a, b) => a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(apart(nodes[i], nodes[j]), `${i} overlaps ${j}`);
});
test('a record waits on its explicit dependencies and every relation field target', () => {
  const fields = [{ id: 'title', type: 'text' }, { id: 'needs', type: 'relation' }, { id: 'after', type: 'relation' }];
  assert.deepEqual(blockersOf({ blockedBy: ['a', 'b'], cells: { title: 'x', needs: ['b', 'c'], after: ['d'] } }, fields), ['a', 'b', 'c', 'd']);
  assert.deepEqual(blockersOf({ cells: { needs: 'not a list' } }, fields), []);
});
test('views fall back to a named default for the widget kind', () => {
  const table = { views: [{ id: 'v', kind: 'timeline', name: 'Plan', groupBy: 'team' }] };
  assert.equal(viewFor(table, 'timeline').groupBy, 'team');
  assert.deepEqual(viewFor(table, 'story'), { id: 'story', kind: 'story', name: 'Story map' });
  assert.deepEqual(viewFor(undefined, 'chart'), { id: 'chart', kind: 'chart', name: 'Chart' });
});
test('card editing is undoable and ignored for viewers and commenters', async t => {
  const card = newCard({ x: 0, y: 0 });
  let role = 'edit';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'board', name: 'Board', role, version: 1, updatedAt: 1, data: { ...emptyCanvasState(), nodes: [card] } })));
  t.after(() => useCanvasStore.getState().reset());
  for (role of ['edit', 'view', 'comment']) {
    useCanvasStore.getState().reset();
    await useCanvasStore.getState().loadBoard('board');
    useCanvasStore.getState().updateNodeFields(card.id, { record: { ...card.record, title: 'Changed' } });
    assert.equal(useCanvasStore.getState().history.present.nodes[0].record.title, role === 'edit' ? 'Changed' : 'Untitled task');
    if (role === 'edit') {
      useCanvasStore.getState().undo();
      assert.equal(useCanvasStore.getState().history.present.nodes[0].record.title, 'Untitled task');
    }
  }
});
async function loadNodes(t, nodes) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'board', name: 'Board', role: 'edit', version: 1, updatedAt: 1, data: { ...emptyCanvasState(), nodes } })));
  t.after(() => useCanvasStore.getState().reset());
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard('board');
  return () => useCanvasStore.getState().history.present.nodes;
}
test('a card dragged into a column keeps that lane when the columns are arranged', async t => {
  const columns = { ...newColumns({ x: 0, y: 0 }), swimlanes: [{ id: 'top', name: 'Top', color: '#f1f5f9' }, { id: 'bottom', name: 'Bottom', color: '#f1f5f9' }] };
  const placed = layoutColumns({ nodes: [columns, { ...newCard({ x: 0, y: 0 }), parentId: columns.id, record: { title: 'Placed', lane: columns.lanes[0].id, swimlane: 'top' } }] }, columns.id).nodes;
  const free = newCard({ x: 2000, y: 2000 });
  const nodes = await loadNodes(t, [...placed, free]);
  const width = (columns.w - 20) / 3, row = (placed[0].h - 72) / 2;
  useCanvasStore.getState().setSelection([placed[1].id]);
  useCanvasStore.getState().moveSelectionBy(2 * width, row);
  useCanvasStore.getState().setSelection([free.id]);
  useCanvasStore.getState().moveSelectionBy(columns.x + 10 + width * 1.5 - free.x - free.w / 2, columns.y + 80 - free.y);
  const [dragged, dropped] = nodes().slice(1);
  assert.deepEqual([dragged.parentId, dragged.record.lane, dragged.record.swimlane], [columns.id, columns.lanes[2].id, 'bottom']);
  assert.deepEqual([dropped.parentId, dropped.record.lane, dropped.record.swimlane], [columns.id, columns.lanes[1].id, 'top']);
  const arranged = layoutColumns({ nodes: nodes() }, columns.id).nodes;
  assert.deepEqual([arranged[1].x, arranged[1].y], [columns.x + 16 + 2 * width, columns.y + 84 + row]);
  assert.deepEqual([arranged[2].x, arranged[2].record.lane], [columns.x + 16 + width, columns.lanes[1].id]);
  useCanvasStore.getState().moveSelectionBy(5000, 0);
  assert.deepEqual([nodes()[2].parentId, nodes()[2].record.lane], [null, columns.lanes[1].id]);
});
test('a cell is clamped to the nearest lane and swimlane at the widget edges', () => {
  const columns = newColumns({ x: 100, y: 100 });
  const edge = inColumnsCell({ ...newCard({ x: 100 + columns.w, y: 0 }), w: 40, h: 40 }, columns);
  assert.deepEqual([edge.record.lane, edge.record.swimlane], [columns.lanes[2].id, columns.swimlanes[0].id]);
});
test('deleting the last widget of a table offers its table; a shared table is kept quietly', async t => {
  const widget = (id, datasetId) => ({ id, type: 'work', kind: 'table', title: `Widget ${id}`, datasetId, x: 0, y: 0, w: 640, h: 420, parentId: null, groupId: null });
  await loadNodes(t, [widget('a', 'shared'), widget('b', 'shared'), widget('c', 'solo'), newCard({ x: 0, y: 900 })]);
  useCanvasStore.getState().setSelection(['a']);
  useCanvasStore.getState().deleteSelected();
  assert.deepEqual(useCanvasStore.getState().orphanedTables, []);
  useCanvasStore.getState().setSelection(['b', 'c']);
  useCanvasStore.getState().deleteSelected();
  assert.deepEqual(useCanvasStore.getState().orphanedTables, [{ id: 'shared', name: 'Widget b' }, { id: 'solo', name: 'Widget c' }]);
  useCanvasStore.getState().dismissOrphanedTables();
  assert.deepEqual(useCanvasStore.getState().orphanedTables, []);
  useCanvasStore.getState().undo();
  useCanvasStore.getState().setSelection(['b', 'c']);
  assert.equal(useCanvasStore.getState().cut(), true);
  assert.deepEqual(useCanvasStore.getState().orphanedTables, []);
});
