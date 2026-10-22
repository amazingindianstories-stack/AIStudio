import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useStore } from '../lib/store.js';
import { HistoryPanel } from './HistoryPanel.jsx';

async function harness(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const names = ['window', 'document', 'HTMLElement', 'localStorage', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver'];
  const prior = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const original = useStore.getState();
  useStore.setState({ currentUser: { id: 'one' }, items: [], selectedIds: [], projects: [], activeProjectId: null,
    activeFolderId: null, libraryTree: { globalFolders: [], projects: [] }, operations: {}, rightTab: 'history', loading: false });
  const root = createRoot(document.querySelector('#root'));
  try { await run({ render: () => act(async () => root.render(React.createElement(HistoryPanel))) }); }
  finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
}
const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
const key = actor => `veevee-active-media-export-v1:${actor}`;

test('ZIP restore shows explicit download without navigating or requesting a grant, actor switch clears previous notice', async () => {
  await harness(async ({ render }) => {
    localStorage.setItem(key('one'), 'job');
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); return reply(200, { id: 'job', status: 'ready', totalItems: 2 }); };
    await render();
    const link = document.querySelector('a[href="/api/history/exports/job/download"]');
    assert.ok(link); assert.equal(link.target, ''); assert.ok(link.hasAttribute('download'));
    assert.deepEqual(calls, ['/api/history/exports/job']);
    assert.equal(localStorage.getItem(key('one')), 'job');
    await act(async () => useStore.setState({ currentUser: { id: 'two' } }));
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.equal(localStorage.getItem(key('two')), null);
  });
});

for (const status of [401, 403, 404, 410]) test(`ZIP restore handles HTTP${status} without indefinite queued state`, async () => {
  await harness(async ({ render }) => {
    localStorage.setItem(key('one'), 'job');
    globalThis.fetch = async () => reply(status, {});
    await render();
    if (status === 410) assert.match(document.querySelector('[role="status"]').textContent, /expired/);
    else { assert.equal(document.querySelector('[role="status"]'), null); assert.equal(localStorage.getItem(key('one')), null); }
  });
});

test('ZIP rapid activation creates and finalizes once;409 reason is visible and retry is explicit', async () => {
  await harness(async ({ render }) => {
    useStore.setState({ items: [{ id: 'image', kind: 'image', status: 'succeeded', url: '/api/media/generations/image.png', prompt: 'fixture', aspectRatio: '1:1', model: 'Fixture', createdAt: 1 }], selectedIds: ['image'] });
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(url); return url.endsWith('/finalize') ? reply(409, { error: 'Selected source unavailable.' }) : reply(200, url.endsWith('/items') ? { rejected: [] } : { id: 'job' }); };
    await render();
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Download ZIP');
    await act(async () => { button.click(); button.click(); });
    assert.equal(calls.filter(url => url === '/api/history/exports').length, 1);
    assert.equal(calls.filter(url => url.endsWith('/finalize')).length, 1);
    assert.match(document.querySelector('[role="status"]').textContent, /Selected source unavailable/);
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Retry'));
  });
});

test('folder navigation toggle exposes its state and Escape returns focus without closing the library', async () => {
  await harness(async ({ render }) => {
    await render();
    const toggle = [...document.querySelectorAll('button[aria-controls]')].find(button => button.textContent === 'Folders');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(document.getElementById(toggle.getAttribute('aria-controls')));
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, 'Back to assets');
    toggle.focus();
    let escaped = false;
    document.addEventListener('keydown', () => { escaped = true; });
    await act(async () => toggle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, toggle);
    assert.equal(escaped, false, 'Escape closes folders before it can close the outer drawer');
  });
});
