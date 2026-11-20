import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { useModalFocus } from './useModalFocus.js';

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const root = createRoot(document.querySelector('#root'));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
  try { await run({ root, settle }); } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}
const press = (key, init = {}) => act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const h = React.createElement;

function Modal({ label, onClose }) {
  const { ref } = useModalFocus(null, { onClose });
  return h('div', { ref, role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabIndex: -1 },
    h('button', { id: `${label}-first` }, 'first'), h('button', { id: `${label}-last` }, 'last'));
}
function App({ stacked = false }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return h(React.Fragment, null,
    h('button', { id: 'opener', onClick: () => setOpen(true) }, 'open'),
    h('button', { id: 'behind' }, 'behind'),
    open && h(Modal, { label: 'outer', onClose: () => setOpen(false) }),
    stacked && open && h('button', { id: 'stack', onClick: () => setInner(true) }, 'stack'),
    inner && h(Modal, { label: 'inner', onClose: () => setInner(false) }));
}

test('focuses the first control, wraps Tab, pulls stray focus back, closes on Escape and restores the opener', async () => {
  await withDom(async ({ root, settle }) => {
    await act(async () => root.render(h(App)));
    const opener = document.querySelector('#opener');
    opener.focus();
    await act(async () => opener.click());
    await settle();
    assert.equal(document.activeElement.id, 'outer-first');
    document.querySelector('#outer-last').focus();
    await press('Tab');
    assert.equal(document.activeElement.id, 'outer-first');
    await press('Tab', { shiftKey: true });
    assert.equal(document.activeElement.id, 'outer-last');
    document.querySelector('#behind').focus();
    assert.equal(document.querySelector('[role="dialog"]').contains(document.activeElement), true);
    await press('Escape');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, opener);
  });
});

test('only the newest of two stacked modals traps focus and handles Escape', async () => {
  await withDom(async ({ root, settle }) => {
    await act(async () => root.render(h(App, { stacked: true })));
    await act(async () => document.querySelector('#opener').click());
    await settle();
    const stack = document.querySelector('#stack');
    stack.focus();
    await act(async () => stack.click());
    await settle();
    assert.equal(document.activeElement.id, 'inner-first');
    await press('Escape');
    assert.equal(document.querySelector('[aria-label="inner"]'), null);
    assert.ok(document.querySelector('[aria-label="outer"]'), 'outer stays open after the inner one closes');
    await press('Escape');
    assert.equal(document.querySelector('[aria-label="outer"]'), null);
  });
});
