import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useComposerCollapse } from './useComposerCollapse.js';

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div><div role="menu"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT'];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root'));
  try { await run(root, dom); } finally { Object.assign(globalThis, prior); dom.window.close(); }
}

function mount(root, api) {
  function Probe() {
    const c = useComposerCollapse();
    api.current = c;
    return React.createElement('div', { ...c.shellProps, id: 'shell' });
  }
  return act(async () => root.render(React.createElement(Probe)));
}

test('unmounting removes the pending mousemove recheck listener (FE-035)', async () => {
  await withDom(async (root) => {
    const api = {};
    await mount(root, api);
    const removed = [];
    const original = document.removeEventListener.bind(document);
    document.removeEventListener = (type, ...rest) => { removed.push(type); return original(type, ...rest); };
    const shell = document.querySelector('#shell');
    await act(async () => { shell.dispatchEvent(new window.Event('mouseleave')); });
    await act(async () => root.unmount());
    assert.ok(removed.includes('mousemove'));
  });
});

test('file picker flag clears on cancel and the focus listener goes away on unmount (FE-035)', async () => {
  await withDom(async (root) => {
    const api = {};
    await mount(root, api);
    const input = document.createElement('input');
    let clicks = 0;
    input.click = () => { clicks += 1; };
    const added = []; const removed = [];
    const add = window.addEventListener.bind(window); const rem = window.removeEventListener.bind(window);
    window.addEventListener = (t, ...r) => { added.push(t); return add(t, ...r); };
    window.removeEventListener = (t, ...r) => { removed.push(t); return rem(t, ...r); };
    await act(async () => api.current.openFilePicker({ current: input }));
    assert.equal(clicks, 1);
    input.dispatchEvent(new window.Event('cancel'));
    assert.ok(removed.includes('focus'), 'cancel releases the window focus listener');
    removed.length = 0;
    await act(async () => api.current.openFilePicker({ current: input }));
    await act(async () => root.unmount());
    assert.ok(removed.includes('focus'));
  });
});
