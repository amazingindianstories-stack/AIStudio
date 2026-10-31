import test from 'node:test';
import assert from 'node:assert/strict';
import { newCard, newColumns, layoutColumns, cleanRecord, viewFor, blockersOf, placeWorkNode } from './work-records.js';
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
