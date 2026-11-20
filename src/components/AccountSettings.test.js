import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { AccountSettings } from './AccountSettings.jsx';

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const root = createRoot(document.querySelector('#root'));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
  try { await run({ root, settle }); } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}

test('a parent re-render with a fresh onClose neither restores focus to the opener nor pulls it from a field being filled', async () => {
  await withDom(async ({ root, settle }) => {
    const user = { id: 1, name: 'Ada', email: 'ada@example.com', avatarUrl: null };
    const view = () => React.createElement(React.Fragment, null,
      React.createElement('button', { id: 'opener' }, 'Opener'),
      React.createElement(AccountSettings, { open: true, user, onClose: () => {}, onUserUpdated: async () => {} }));
    await act(async () => root.render(view()));
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog on open');
    const field = dialog.querySelector('input:not([type="file"])');
    field.focus();
    await act(async () => root.render(view()));
    await settle();
    assert.equal(document.activeElement, field);
  });
});
