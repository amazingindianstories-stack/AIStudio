import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { VideoRefPicker } from './VideoRefPicker.jsx';

test('clip picker is a named modal dialog that takes focus, traps Tab, closes on Escape and returns focus', async () => {
  const dom = new JSDOM('<button id="opener">+</button><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'ResizeObserver', 'IntersectionObserver'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id), KeyboardEvent: dom.window.KeyboardEvent,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [] }) }) });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const root = createRoot(document.querySelector('#root'));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
  const press = (key, init = {}) => act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  try {
    const opener = document.querySelector('#opener');
    opener.focus();
    let closed = 0;
    const render = (open) => act(async () => root.render(open ? React.createElement(VideoRefPicker, { onClose: () => { closed += 1; } }) : null));
    await render(true);
    await settle();
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent.trim(), 'Attach reference clips');
    assert.ok(dialog.contains(document.activeElement), 'focus moves into the picker');
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
