import assert from 'node:assert/strict';
import test from 'node:test';
import { workQuery } from './work-api.js';

test('tables page through records while every other view asks for the complete grouped query', () => {
  const query = { q: 'launch', sort: 'end', direction: 'desc', filterField: '', filterValue: '', offset: 200 };
  assert.deepEqual(Object.fromEntries(new URLSearchParams(workQuery('table', query, 'status'))),
    { q: 'launch', sort: 'end', direction: 'desc', filterField: '', filterValue: '', offset: '200', groupBy: 'status' });
  for (const kind of ['kanban', 'timeline', 'story', 'mindmap', 'org', 'chart']) {
    const params = new URLSearchParams(workQuery(kind, query, ''));
    assert.equal(params.get('all'), '1', kind);
    assert.equal(params.get('offset'), '0', kind);
    assert.equal(params.get('q'), 'launch', kind);
  }
});
