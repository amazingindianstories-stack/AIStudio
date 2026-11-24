import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { AudioTranscriptionModal } from './AudioTranscriptionModal.jsx';

test('audio transcription modal is a labelled dialog that takes focus, traps Tab, closes on Escape and returns focus', async () => {
  const dom = new JSDOM('<button id="opener">+</button><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent,
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) }) });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const root = createRoot(document.querySelector('#root'));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
  const press = (key, init = {}) => act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  try {
    const opener = document.querySelector('#opener');
    opener.focus();
    let closed = 0;
    const render = (open) => act(async () => root.render(React.createElement(AudioTranscriptionModal, { open, projectId: null, onClose: () => { closed += 1; } })));
    await render(true);
    await settle();
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    assert.equal(dialog.getAttribute('aria-label'), 'Audio transcription');
    const zone = dialog.querySelector('[role="button"][tabindex="0"]');
    assert.ok(zone && zone.textContent.startsWith('Drop audio here or browse'), 'the shared audio drop zone');
    assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog');
    const controls = [...dialog.querySelectorAll('button:not(:disabled)')];
    controls[controls.length - 1].focus();
    await press('Tab');
    assert.equal(document.activeElement, controls[0]);
    await press('Escape');
    assert.equal(closed, 1);
    await render(false);
    assert.equal(document.activeElement, opener);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
});

test('audio transcription modal aborts its history fetch on unmount and shows a load error', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  let signal = null;
  let mode = 'hang';
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent,
    fetch: (url, init) => {
      signal = init?.signal || null;
      if (mode === 'fail') return Promise.reject(new Error('network'));
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    } });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
  const errors = [];
  const origError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    let root = createRoot(document.querySelector('#root'));
    await act(async () => root.render(React.createElement(AudioTranscriptionModal, { open: true, projectId: null, onClose() {} })));
    await settle();
    assert.ok(signal, 'the history fetch receives an AbortSignal');
    assert.equal(signal.aborted, false);
    await act(async () => root.unmount());
    await settle();
    assert.equal(signal.aborted, true, 'unmount aborts the in-flight fetch');
    assert.deepEqual(errors, []);

    mode = 'fail';
    root = createRoot(document.querySelector('#root'));
    await act(async () => root.render(React.createElement(AudioTranscriptionModal, { open: true, projectId: null, onClose() {} })));
    await settle();
    assert.match(document.querySelector('[role="alert"]').textContent, /Could not load history/);
    await act(async () => root.unmount());
  } finally { console.error = origError; Object.assign(globalThis, prior); dom.window.close(); }
});
