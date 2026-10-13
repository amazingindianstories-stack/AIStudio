import test from 'node:test';
import assert from 'node:assert/strict';
import { useStore } from './store.js';
import { disposeStoreRuntime, storeRuntime } from './store-runtime.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('queued work resumes through read-only updates and reaches completion without browser execution', async (t) => {
  disposeStoreRuntime();
  const initial = useStore.getState();
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const calls = [];
  let poll = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, options });
    assert.match(path, /^\/api\/history\/updates\?since=/);
    return Response.json({ items: [{ id: 'job', kind: 'video', status: ++poll === 1 ? 'running' : 'succeeded', updatedAt: poll + 10, createdAt: 1, url: poll === 2 ? '/api/media/master.mov' : null }], now: 500 + poll });
  });
  try {
    useStore.setState({ items: [{ id: 'job', kind: 'video', status: 'queued', updatedAt: 1, createdAt: 1 }], threadItems: [], pendingItems: [], rightTab: 'library', filterKind: 'all', activeProjectId: null, activeFolderId: null, search: '' });
    useStore.getState().startLiveUpdates();
    useStore.getState().startLiveUpdates();
    assert.equal(timers.length, 1);
    timers.shift().callback(); await flush();
    assert.equal(useStore.getState().items[0].status, 'running');
    assert.equal(timers[0].delay, 3000);
    timers.shift().callback(); await flush();
    assert.equal(useStore.getState().items[0].status, 'succeeded');
    assert.equal(timers[0].delay, 20000);
    assert.equal(calls.length, 2);
    assert.match(calls[1].path, /since=501$/);
    for (const { options } of calls) assert.equal(options.method || 'GET', 'GET');
  } finally { disposeStoreRuntime(); useStore.setState(initial, true); }
});

test('a response from a disposed login cannot enter the next session live feed', async (t) => {
  disposeStoreRuntime();
  const initial = useStore.getState();
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback) => { timers.push(callback); return callback; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  try {
    useStore.setState({ items: [], threadItems: [], pendingItems: [] });
    useStore.getState().startLiveUpdates(); timers.shift()();
    disposeStoreRuntime();
    useStore.getState().startLiveUpdates();
    const watermark = storeRuntime.liveSince;
    finish(Response.json({ items: [{ id: 'prior-user', kind: 'image', status: 'succeeded' }], now: 1 }));
    await flush();
    assert.deepEqual(useStore.getState().items, []);
    assert.equal(storeRuntime.liveSince, watermark);
  } finally { disposeStoreRuntime(); useStore.setState(initial, true); }
});
