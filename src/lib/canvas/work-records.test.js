import test from 'node:test';
import assert from 'node:assert/strict';
import { newCard, newColumns, layoutColumns, cleanRecord } from './work-records.js';
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
