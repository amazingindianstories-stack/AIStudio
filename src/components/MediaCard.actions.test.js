import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useStore } from '../lib/store.js';
import { MediaCard } from './MediaCard.jsx';
import { FeedBlock } from './ConversationPanel.jsx';
import { useMaintenance } from '../lib/maintenance-client.js';

async function harness(item, run, state = {}, Component = MediaCard) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const original = useStore.getState();
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init?.method || 'GET']); return { ok: true, status: 200, json: async () => ({}) }; };
  useStore.setState({ currentUser: { id: "admin", role: "admin" }, items: [item], selectedIds: [], usersById: {}, libraryTree: { globalFolders: [], projects: [] }, prompt: '', referenceImages: [], ...state });
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(Component, { item, selectable: true, index: 1 })));
    await run({ calls, card: document.querySelector(`[data-asset-card-id="${item.id}"], [data-generation-id="${item.id}"]`) });
  } finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
}
const openMenu = async (el) => act(async () => {
  el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }));
});
const menuKeys = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.dataset.menuItem);
const menuItem = (key) => document.querySelector(`[role="menu"] [data-menu-item="${key}"]`);
const failed = { id: 'f1', kind: 'video', status: 'failed', moderationBlocked: true, error: 'BytePlus rejected the reference image', prompt: 'Sati @img1 walks', model: 'Seedance 2.5',
  aspectRatio: '21:9', resolution: '480p', duration: 10, referenceImages: ['/api/media/uploads/image-reference/a', '/api/media/uploads/portrait/b'], createdAt: 1 };

test('library number and main chat full-name overlays expose the complete filename accessibly', async () => {
  for (const Component of [MediaCard, FeedBlock]) {
    for (const filename of ['Shiv_Sati_Very_Long_Folder_Ancestry_0001.mov', 'unsorted_0002.png', 'Scene_10000.mov', 'Scene.with.dots_0042.mov']) {
      await harness({ ...failed, filename }, async ({ card }) => {
        const name = card.querySelector('[data-generation-name]');
        assert.equal(name.title, filename);
        assert.equal(name.querySelector('.sr-only').textContent, filename);
        assert.equal([...name.querySelectorAll('[aria-hidden="true"]')].map(el => el.textContent).join(''), Component === MediaCard ? filename.match(/_(\d+)\.[^.]+$/)[1] : filename.replace(/\.[^.]+$/, ''));
      }, {}, Component);
    }
  }
});

test('library and main chat cards omit the overlay until the item has a filename', async () => {
  for (const Component of [MediaCard, FeedBlock]) {
    await harness(failed, async ({ card }) => {
      const name = card.querySelector('[data-generation-name]');
      assert.equal(name, null);
    }, {}, Component);
  }
});

test('failed card has no in-card generate buttons; its menu Edit & retry confirms then restores prompt and references without submitting', async () => {
  await harness(failed, async ({ calls, card }) => {
    assert.equal([...card.querySelectorAll('button')].some(b => /Retry|Edit/.test(b.textContent)), false);
    await openMenu(card);
    assert.deepEqual(menuKeys(), ['retry', 'retry-text', 'edit', 'folder', 'select', 'delete']);
    await act(async () => menuItem('edit').click());
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.match(document.body.textContent, /Edit and retry\?/);
    assert.equal(useStore.getState().prompt, '');
    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Load into composer');
    await act(async () => confirm.click());
    const s = useStore.getState();
    assert.equal(s.prompt, 'Sati @img1 walks');
    assert.deepEqual(s.referenceImages, failed.referenceImages);
    assert.equal(calls.some(([url]) => String(url).startsWith('/api/generate')), false);
  });
});

test('during maintenance Edit & retry stays enabled and loads the composer while retry and delete stay blocked', async () => {
  useMaintenance.setState({ enabled: true });
  try {
    await harness(failed, async ({ calls, card }) => {
      await openMenu(card);
      for (const key of ['retry', 'retry-text', 'delete']) assert.equal(menuItem(key).getAttribute('aria-disabled'), 'true', key);
      assert.notEqual(menuItem('edit').getAttribute('aria-disabled'), 'true');
      await act(async () => menuItem('edit').click());
      const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Load into composer');
      assert.equal(confirm.disabled, false);
      await act(async () => confirm.click());
      const s = useStore.getState();
      assert.equal(s.prompt, 'Sati @img1 walks');
      assert.deepEqual(s.referenceImages, failed.referenceImages);
      assert.equal(document.body.textContent.includes('Edit and retry?'), false);
      assert.equal(calls.some(([url]) => String(url).startsWith('/api/generate')), false);
    });
  } finally { useMaintenance.setState({ enabled: false }); }
});

test('rendering card delete is blocked in the menu and says why', async () => {
  await harness({ ...failed, id: 'r1', status: 'running', error: null, moderationBlocked: false }, async ({ calls, card }) => {
    await openMenu(card);
    assert.deepEqual(menuKeys(), ['edit', 'folder', 'select', 'delete']);
    const del = menuItem('delete');
    assert.equal(del.getAttribute('aria-disabled'), 'true');
    assert.match(del.getAttribute('title'), /Still rendering/);
    await act(async () => del.click());
    assert.equal(document.body.textContent.includes('Delete this generation?'), false);
    assert.ok(document.querySelector('[role="menu"]'), 'a disabled item does not close the menu');
    assert.equal(calls.length, 0);
  });
});

test('a finished Seedance 2.5 draft offers retry, finalization, download and the rest, with its details', async () => {
  const createdAt = Date.now() - 90_000;
  const item = { ...failed, id: 'd1', status: 'succeeded', error: null, moderationBlocked: false, draftMode: true, taskId: 'cgt-1', createdAt,
    submittedAt: createdAt + 5_000, completedAt: createdAt + 77_000, costCents: 42, userId: 'u1', filename: 'Sati_001.mov', url: '/api/media/generations/d1.mov' };
  await harness(item, async ({ card }) => {
    await openMenu(card);
    assert.deepEqual(menuKeys(), ['retry', 'edit', 'finalize', 'open', 'download', 'favorite', 'folder', 'select', 'delete']);
    const menu = document.querySelector('[data-card-context-menu]');
    const detail = (name) => menu.querySelector(`[data-detail="${name}"]`).textContent;
    assert.equal(detail('creator'), 'Asha');
    assert.match(detail('model'), /^Seedance 2\.5Draft$/);
    assert.equal(detail('output'), '480p · 21:9 · 10s');
    assert.equal(detail('cost'), '≈$0.42');
    assert.equal(detail('took'), '1m 17s');
    assert.equal(menuItem('download').textContent.includes('MOV'), true);
    await act(async () => menuItem('finalize').click());
    assert.match(document.body.textContent, /Generate the 1080p final\?/);
  }, { usersById: { u1: { name: 'Asha', email: 'asha@example.test', color: '#fff' } } });
});

test('the card face holds only the avatar, the draft label, the checkbox, the "..." button and the favourite star', async () => {
  const base = { ...failed, status: 'succeeded', error: null, moderationBlocked: false, url: '/api/media/generations/v.mov', createdAt: Date.now(), userId: 'u1' };
  const users = { usersById: { u1: { name: 'Asha', email: 'asha@example.test' } } };
  await harness({ ...base, id: 'draft-1', draftMode: true }, async ({ card }) => {
    assert.equal(card.querySelector('[data-draft-label]').textContent, 'Draft');
    assert.doesNotMatch(card.className, /outline-dashed/);
    const controls = [...card.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
    // The star owns the bottom-right corner; "..." sits just inside it.
    assert.deepEqual(controls, ['Select', 'More actions', 'Add to favourites']);
    assert.equal(card.querySelector('[data-favorite-star]').getAttribute('aria-pressed'), 'false');
    assert.equal(card.querySelector('.media-card-avatar').textContent, 'A');
    assert.equal(card.querySelector('time'), null);
    assert.equal(card.textContent.replace(/\s/g, ''), 'DraftA');
  }, users);
  await harness({ ...base, id: 'final-1', draftMode: false }, async ({ card }) => {
    assert.equal(card.querySelector('[data-draft-label]'), null);
  }, users);
  await harness({ ...base, id: 'fav-1', draftMode: true, isFavorite: true }, async ({ card }) => {
    const star = card.querySelector('[data-favorite-star]');
    assert.equal(star.getAttribute('aria-pressed'), 'true');
    assert.equal(star.getAttribute('aria-label'), 'Remove from favourites');
    // A favourite's star stays at rest (not hover-only) and is filled.
    assert.doesNotMatch(star.className, /opacity-0/);
    assert.match(star.querySelector('svg').getAttribute('class'), /fill-current/);
  }, users);
  await harness({ ...base, id: 'running-1', status: 'running', url: null }, async ({ card }) => {
    assert.equal(card.querySelector('[data-favorite-star]'), null, 'only finished generations can be favourited');
  }, users);
});

test('during maintenance an unfavourited card has no favourite star while a favourite keeps its disabled star', async () => {
  const base = { ...failed, status: 'succeeded', error: null, moderationBlocked: false, url: '/api/media/generations/v.mov', createdAt: Date.now() };
  useMaintenance.setState({ enabled: true });
  try {
    await harness({ ...base, id: 'plain-1' }, async ({ card }) => {
      assert.equal(card.querySelector('[data-favorite-star]'), null);
    });
    await harness({ ...base, id: 'fav-2', isFavorite: true }, async ({ calls, card }) => {
      const star = card.querySelector('[data-favorite-star]');
      assert.equal(star.disabled, true);
      assert.equal(star.getAttribute('aria-pressed'), 'true');
      // Rendering resolves the thumbnail (read-only); the click itself must send nothing.
      const before = [...calls];
      await act(async () => star.click());
      assert.deepEqual(calls, before);
    });
  } finally { useMaintenance.setState({ enabled: false }); }
});

test('the "..." button opens the same menu and toggles it closed; Escape closes it', async () => {
  await harness({ ...failed, id: 'm1', status: 'succeeded', error: null, moderationBlocked: false, url: '/x.png', kind: 'image' }, async ({ card }) => {
    const more = card.querySelector('[aria-label="More actions"]');
    await act(async () => more.click());
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    assert.ok(document.querySelector('[role="menu"][aria-label="Generation actions"]'));
    await act(async () => more.click());
    assert.equal(document.querySelector('[role="menu"]'), null);
    await openMenu(card);
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
  });
});


test('non-admin owners and other users have no delete action in generation menus', async () => {
  for (const id of ['owner', 'other']) {
    for (const status of ['failed', 'running', 'succeeded']) {
      await harness({ ...failed, userId: 'owner', status, url: status === 'succeeded' ? '/api/media/master.mov' : null }, async ({ card }) => {
        await openMenu(card);
        assert.equal(menuItem('delete'), null);
        assert.ok(menuItem('select'));
        assert.ok(menuItem('folder'));
      }, { currentUser: { id, role: 'user' } });
    }
  }
});

test('Cancel uses the existing confirmation and only supported active cards offer it to their owner or admin', async () => {
  const item = { ...failed, status: 'running', moderationBlocked: false, canCancel: true, userId: 'owner', error: null };
  let requests = 0;
  await harness(item, async ({ card }) => {
    await openMenu(card);
    assert.ok(menuItem('cancel'));
    await act(async () => menuItem('cancel').click());
    assert.equal(requests, 0);
    assert.match(document.body.textContent, /Cancel this generation\?/);
    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel generation');
    await act(async () => confirm.click());
    assert.equal(requests, 1);
    assert.match(document.body.textContent, /already started/);
  }, { currentUser: { id: 'owner', role: 'user' }, cancelGeneration: async () => { requests++; return { ok: false, error: 'The provider already started this task.' }; } });
  for (const [row, currentUser] of [[{ ...item, canCancel: false }, { id: 'owner', role: 'user' }],
    [item, { id: 'another-user', role: 'user' }], [{ ...item, status: 'cancelled' }, { id: 'owner', role: 'user' }]]) {
    await harness(row, async ({ card }) => { await openMenu(card); assert.equal(menuItem('cancel'), null); }, { currentUser });
  }
});

test('cancelled cards render their terminal label using the existing failure treatment', async () => {
  await harness({ ...failed, status: 'cancelled', error: null, moderationBlocked: false }, async ({ card }) => {
    assert.match(card.textContent, /Cancelled/);
    await openMenu(card);
    assert.equal(menuItem('delete').getAttribute('aria-disabled'), null);
  });
});
