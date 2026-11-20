import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useStore } from '../lib/store.js';
import { MediaCard } from './MediaCard.jsx';
import { __setMediaResolverFetch } from '../lib/media-resolver.js';

const item = { id: 'g1', kind: 'image', status: 'succeeded', url: '/api/media/generations/g1.png', prompt: 'Sati walks', filename: 'Scene_0001.png', createdAt: 1, aspectRatio: '1:1', model: 'Nano Banana Pro' };

async function withCard(it, run, state = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  __setMediaResolverFetch(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  const original = useStore.getState();
  useStore.setState({ currentUser: { id: 'admin', role: 'admin' }, items: [it], selectedIds: [], usersById: {}, libraryTree: { globalFolders: [], projects: [] }, ...state });
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(MediaCard, { item: it, selectable: true, index: 1 })));
    await run(document.querySelector(`[data-asset-card-id="${it.id}"]`));
  } finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
}
const byName = (card, role, name) => [...card.querySelectorAll(role === 'button' ? 'button:not([role])' : `[role="${role}"]`)]
  .filter(el => (el.getAttribute('aria-label') || '').match(name));

test('selectable card root is a labelled group, not a button, and carries no aria-selected', async () => {
  await withCard(item, async (card) => {
    assert.equal(card.getAttribute('role'), 'group');
    assert.equal(card.getAttribute('aria-label'), 'Scene_0001.png');
    assert.equal(card.hasAttribute('aria-selected'), false);
    assert.equal(card.hasAttribute('aria-haspopup'), false);
    assert.equal(card.hasAttribute('tabindex'), false);
  });
});

test('open button and select checkbox are distinct siblings, never nested in a button', async () => {
  await withCard(item, async (card) => {
    const [open] = byName(card, 'button', /open/i);
    const [checkbox] = byName(card, 'checkbox', /^Select$/);
    assert.ok(open && checkbox);
    assert.notEqual(open, checkbox);
    assert.equal(open.getAttribute('aria-label'), 'Open Scene_0001.png');
    assert.equal(open.contains(checkbox), false);
    for (const button of card.querySelectorAll('button')) assert.equal(button.querySelector('button, [role="checkbox"]'), null);
    // Selection state lives on the checkbox only.
    assert.equal(checkbox.getAttribute('aria-checked'), 'false');
  });
});

test('roving tabindex lands on the open button and the face controls of the focused card only', async () => {
  await withCard(item, async (card) => {
    const tabbable = [...card.querySelectorAll('button')].filter(b => b.tabIndex === 0).map(b => b.getAttribute('aria-label'));
    assert.deepEqual(tabbable, ['Open Scene_0001.png', 'Select', 'More actions', 'Add to favourites']);
  });
  await withCard(item, async (card) => {
    assert.deepEqual([...card.querySelectorAll('button')].filter(b => b.tabIndex === 0), []);
  }, { focusedAssetId: 'other' });
});

test('Enter on the open button opens the viewer and focusing it records the roving target', async () => {
  await withCard(item, async (card) => {
    const open = card.querySelector('[data-card-open]');
    await act(async () => open.focus());
    assert.equal(useStore.getState().focusedAssetId, 'g1');
    await act(async () => open.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(useStore.getState().activeId, 'g1');
  });
});

test('a card that is not finished labels its control as actions and Enter does not open a menu', async () => {
  await withCard({ ...item, status: 'running', url: null }, async (card) => {
    const open = card.querySelector('[data-card-open]');
    assert.equal(open.getAttribute('aria-label'), 'Actions for Scene_0001.png');
    await act(async () => open.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
  });
});
