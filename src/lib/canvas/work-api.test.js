import assert from 'node:assert/strict';
import test from 'node:test';
import { previewLimit, watchWork, workQuery } from './work-api.js';

const params = value => Object.fromEntries(new URLSearchParams(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the open panel asks for its table page or the complete result and previews ask for a bounded page', () => {
  const query = { q: 'launch', sort: 'end', direction: 'desc', filterField: '', filterValue: '', offset: 200 };
  assert.deepEqual(params(workQuery('table', query)),
    { q: 'launch', sort: 'end', direction: 'desc', filterField: '', filterValue: '', offset: '200', view: 'table' });
  for (const kind of ['kanban', 'timeline', 'story', 'mindmap', 'org', 'chart']) {
    assert.deepEqual(params(workQuery(kind, query)), { ...params(workQuery('table', query)), view: kind, all: '1', offset: '0' }, kind);
    assert.deepEqual(params(workQuery(kind, undefined, 42)), { view: kind, offset: '0', limit: '42' }, kind);
  }
});

test('preview limits follow the widget size within the server page cap', () => {
  assert.equal(previewLimit({ w: 600, h: 400 }), 42);
  assert.equal(previewLimit({ w: 100, h: 20 }), 10);
  assert.equal(previewLimit({ w: 5000, h: 5000 }), 200);
});

test('a widget preview and its open panel share one polled query', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ table: { views: [] }, records: [], total: 0, offset: 0, limit: 1, aggregates: {}, groups: [] }));
  });
  const source = { path: '/api/canvas-boards/board/work/table', nodeId: 'widget', kind: 'kanban' };
  const seen = { preview: [], panel: [] };
  const preview = watchWork(source, { query: null, limit: 40, update: state => seen.preview.push(state) });
  await settle();
  assert.deepEqual(urls.map(url => params(url.split('?')[1])), [{ view: 'kanban', offset: '0', limit: '40' }]);
  const panel = watchWork(source, { query: { q: 'x' }, limit: 0, update: state => seen.panel.push(state) });
  assert.deepEqual(seen.panel, []);
  await settle();
  assert.deepEqual(urls.slice(1).map(url => params(url.split('?')[1])), [{ q: 'x', view: 'kanban', all: '1', offset: '0' }]);
  assert.equal(seen.preview.at(-1), seen.panel.at(-1));
  assert.equal(seen.panel.at(-1).complete, true);
  panel.close();
  await preview.refresh();
  assert.deepEqual(params(urls.at(-1).split('?')[1]), { view: 'kanban', offset: '0', limit: '40' });
  preview.close();
  const reopened = watchWork(source, { query: { q: '' }, limit: 0, update: () => {} });
  const again = watchWork(source, { query: null, limit: 40, update: () => {} });
  await settle();
  assert.equal(urls.length, 4);
  assert.equal(params(urls.at(-1).split('?')[1]).all, '1');
  reopened.close(); again.close();
});
