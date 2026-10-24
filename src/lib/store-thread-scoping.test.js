import test from 'node:test';
import assert from 'node:assert/strict';
import { useStore, mergeLiveItems } from './store.js';
import { UNSORTED } from './feed-scope.js';

const row = (id, projectId, folderId, updatedAt = 1) => ({ id, projectId, folderId, updatedAt,
  createdAt: 1, kind: 'image', prompt: id, status: 'succeeded' });

test('chat requests the open folder, project Unsorted and global Unsorted with library semantics', async (t) => {
  const initial = useStore.getState();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async path => { calls.push(new URL(path, 'http://local')); return Response.json({ items: [] }); });
  try {
    for (const [activeProjectId, activeFolderId, project, folder] of [
      ['project', 'shot', 'project', 'shot'], ['project', UNSORTED, 'project', 'none'],
      [null, UNSORTED, 'none', 'none'], [null, 'global-shot', 'none', 'global-shot'],
      ['project', null, 'project', null], [null, null, 'none', null],
    ]) {
      useStore.setState({ activeProjectId, activeFolderId, rightTab: 'favorites', search: 'unrelated', filterKind: 'video' });
      await useStore.getState().loadThread();
      const params = calls.at(-1).searchParams;
      assert.equal(params.get('projectId'), project);
      assert.equal(params.get('folderId'), folder);
      assert.equal(params.has('q'), false);
      assert.equal(params.get('limit'), '60');
    }
  } finally { useStore.setState(initial, true); }
});

test('switching folders clears the old thread and rejects a late response for the previous folder', async (t) => {
  const initial = useStore.getState();
  const replies = [];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => replies.push(resolve)));
  try {
    useStore.setState({ activeProjectId: 'p', activeFolderId: 'a', threadItems: [row('old', 'p', 'a')] });
    const first = useStore.getState().loadThread();
    assert.deepEqual(useStore.getState().threadItems, []);
    useStore.setState({ activeFolderId: 'b' });
    const second = useStore.getState().loadThread();
    replies[1](Response.json({ items: [row('b', 'p', 'b')] }));
    await second;
    replies[0](Response.json({ items: [row('a', 'p', 'a')] }));
    await first;
    assert.deepEqual(useStore.getState().threadItems.map(item => item.id), ['b']);
  } finally { useStore.setState(initial, true); }
});

test('live moves remove generations from the open folder thread', () => {
  const initial = useStore.getState();
  try {
    useStore.setState({ activeProjectId: 'p', activeFolderId: 'a', items: [], pendingItems: [],
      rightTab: 'project', filterKind: 'all', search: '', threadItems: [row('one', 'p', 'a')] });
    mergeLiveItems([row('one', 'p', 'b', 2)], useStore.setState);
    assert.deepEqual(useStore.getState().threadItems, []);
  } finally { useStore.setState(initial, true); }
});
