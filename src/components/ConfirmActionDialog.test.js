import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { ConfirmActionDialog } from './ConfirmActionDialog.jsx';
import { useConfirmedAction } from './useConfirmedAction.js';

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent });
  // jsdom has no layout, so report every element as rendered.
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const root = createRoot(document.querySelector('#root'));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
  try { await run({ root, settle }); } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}

const press = (key, init = {}) => act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });

function Harness({ run }) {
  const confirmation = useConfirmedAction();
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'opener', onClick: () => confirmation.ask('deleteGeneration', run) }, 'Opener'),
    React.createElement('button', { id: 'behind' }, 'Behind'),
    React.createElement(ConfirmActionDialog, confirmation.dialogProps));
}

test('focus stays in the dialog while the confirmed action runs and returns to the opener afterwards', async () => {
  await withDom(async ({ root, settle }) => {
    let finish;
    await act(async () => root.render(React.createElement(Harness, { run: () => new Promise(resolve => { finish = resolve; }) })));
    const opener = document.querySelector('#opener');
    opener.focus();
    await act(async () => opener.click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog on open');
    assert.equal(document.activeElement.textContent, 'Cancel');

    const confirm = [...dialog.querySelectorAll('button')].find(b => b.textContent !== 'Cancel');
    confirm.focus();
    await act(async () => confirm.click());
    await settle();
    assert.equal(confirm.disabled, true);
    assert.ok(dialog.contains(document.activeElement), 'focus stays in the dialog while busy');
    assert.notEqual(document.activeElement, document.querySelector('#opener'));

    // Escape is ignored while busy, and Tab or stray focus cannot leave the dialog.
    await press('Escape');
    assert.ok(document.querySelector('[role="alertdialog"]'));
    document.querySelector('#behind').focus();
    await settle();
    assert.ok(dialog.contains(document.activeElement), 'focus pulled back from the page behind');

    await act(async () => finish(true));
    await settle();
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.equal(document.activeElement, document.querySelector('#opener'));
  });
});

test('Tab wraps inside the dialog and Escape cancels when idle', async () => {
  await withDom(async ({ root, settle }) => {
    function Plain() {
      const [open, setOpen] = useState(true);
      return React.createElement(React.Fragment, null,
        React.createElement('button', { id: 'opener' }, 'Opener'),
        React.createElement(ConfirmActionDialog, { open, title: 'T', description: 'D', confirmLabel: 'Go', onCancel: () => setOpen(false), onConfirm() {} }));
    }
    await act(async () => root.render(React.createElement(Plain)));
    await settle();
    const buttons = [...document.querySelectorAll('[role="alertdialog"] button')];
    assert.equal(document.activeElement, buttons[0]);
    buttons[1].focus();
    await press('Tab');
    assert.equal(document.activeElement, buttons[0]);
    await press('Escape');
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
  });
});
