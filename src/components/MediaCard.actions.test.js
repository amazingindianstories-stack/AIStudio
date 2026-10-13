import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useStore } from '../lib/store.js';
import { MediaCard } from './MediaCard.jsx';

async function harness(item, run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const original = useStore.getState();
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init?.method || 'GET']); return { ok: true, status: 200, json: async () => ({}) }; };
  useStore.setState({ items: [item], selectedIds: [], usersById: {}, libraryTree: { globalFolders: [], projects: [] }, prompt: '', referenceImages: [] });
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(MediaCard, { item, selectable: true })));
    await run({ calls, card: document.querySelector(`[data-asset-card-id="${item.id}"]`) });
  } finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
}
const hover = async (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
const actionName = (b) => b.getAttribute('aria-label').split(':')[0];
const toolbarButton = (label) => [...document.querySelectorAll('[role="toolbar"] button')].find(b => actionName(b) === label);
const failed = { id: 'f1', kind: 'video', status: 'failed', moderationBlocked: true, error: 'BytePlus rejected the reference image', prompt: 'Sati @img1 walks', model: 'Seedance 2.5',
  aspectRatio: '21:9', resolution: '480p', duration: 10, referenceImages: ['/api/media/uploads/image-reference/a', '/api/media/uploads/portrait/b'], createdAt: 1 };

test('failed card has no in-card generate buttons; hover panel Edit & retry confirms then restores prompt and references without submitting', async () => {
  await harness(failed, async ({ calls, card }) => {
    assert.equal([...card.querySelectorAll('button')].some(b => /Retry|Edit/.test(b.textContent)), false);
    await hover(card);
    assert.deepEqual([...document.querySelectorAll('[role="toolbar"] button')].map(actionName), ['Edit & retry', 'Retry without references', 'Delete']);
    assert.ok(toolbarButton('Edit & retry').querySelector('[role="tooltip"]'));
    await act(async () => toolbarButton('Edit & retry').click());
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

test('rendering card delete is blocked in the panel', async () => {
  await harness({ ...failed, id: 'r1', status: 'running', error: null, moderationBlocked: false }, async ({ calls, card }) => {
    await hover(card);
    const del = toolbarButton('Delete');
    assert.equal(del.getAttribute('aria-disabled'), 'true');
    assert.match(del.getAttribute('aria-label'), /Still rendering/);
    await act(async () => del.click());
    assert.equal(document.body.textContent.includes('Delete this generation?'), false);
    assert.equal(calls.length, 0);
  });
});

test('draft finalization is not offered as a hover shortcut', async () => {
  await harness({ ...failed, id: 'd1', status: 'succeeded', error: null, moderationBlocked: false, draftMode: true, taskId: 'cgt-1', createdAt: Date.now(), url: '/api/media/generations/d1.mov' }, async ({ card }) => {
    await hover(card);
    const names = [...document.querySelectorAll('[role="toolbar"] button')].map(actionName);
    assert.deepEqual(names, ['Edit & retry', 'Favourite', 'Download', 'Delete']);
  });
});
