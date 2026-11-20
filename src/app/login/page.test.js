import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import LoginPage from './page.jsx';

async function withPage(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/login', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'KeyboardEvent', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, KeyboardEvent: dom.window.KeyboardEvent, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id) });
  // React was loaded without a DOM, so it takes its legacy input path; give jsdom the two calls that path makes.
  dom.window.HTMLElement.prototype.attachEvent = dom.window.HTMLElement.prototype.detachEvent = () => {};
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(LoginPage)));
    await run();
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}

const labelled = (text) => {
  const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === text);
  return label && document.getElementById(label.htmlFor);
};

test('login labels resolve to their inputs', async () => {
  await withPage(async () => {
    const email = labelled('Email');
    const password = labelled('Password');
    assert.equal(email?.type, 'email');
    assert.equal(password?.type, 'password');
  });
});

test('login inputs use 16px text on phones so iOS does not zoom on focus', async () => {
  await withPage(async () => {
    for (const input of document.querySelectorAll('input')) {
      assert.match(input.className, /\btext-base\b/);
      assert.match(input.className, /\bsm:text-sm\b/);
    }
  });
});

test('login error is an alert linked to both inputs', async () => {
  await withPage(async () => {
    const setValue = (el, value) => {
      el.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      el.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'r', bubbles: true }));
    };
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Bad credentials' }) });
    await act(async () => { setValue(labelled('Email'), 'a@b.co'); setValue(labelled('Password'), 'x'); });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, 'error alert rendered');
    assert.equal(alert.id, 'login-error');
    assert.equal(labelled('Email').getAttribute('aria-describedby'), 'login-error');
    assert.equal(labelled('Password').getAttribute('aria-describedby'), 'login-error');
  });
});
