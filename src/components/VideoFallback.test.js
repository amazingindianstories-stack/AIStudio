import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoFallback } from './VideoFallback.jsx';
import { FeedBlock } from './ConversationPanel.jsx';
import { useStore } from '../lib/store.js';

test('full fallback explains the browser limit and offers the original download', () => {
  const html = renderToStaticMarkup(React.createElement(VideoFallback, { href: '/api/generate/download/g1', filename: 'a.mov' }));
  assert.match(html, /This browser cannot play this video/);
  assert.match(html, /href="\/api\/generate\/download\/g1"/);
  assert.match(html, /download="a.mov"/);
  assert.match(html, /Download original/);
});

test('compact tile fallback shows the icon, duration and message without a button', () => {
  const html = renderToStaticMarkup(React.createElement(VideoFallback, { compact: true, duration: '5s' }));
  assert.match(html, /<svg/);
  assert.match(html, /5s/);
  assert.match(html, /text-\[11px\] text-muted/);
  assert.match(html, /Preview unavailable\. Open to download the original\./);
  assert.doesNotMatch(html, /<a /);
});

test('MediaCard renders the compact fallback for an undecodable video', () => {
  const src = fs.readFileSync(new URL('./MediaCard.jsx', import.meta.url), 'utf8');
  assert.match(src, /<VideoFallback compact/);
});

test('feed swaps a video that fails to decode for the fallback with a download link', async () => {
  const item = { id: 'v1', kind: 'video', status: 'succeeded', url: '/api/media/x.mov', filename: 'x.mov', prompt: 'p', model: 'Seedance 2.5', aspectRatio: '16:9', createdAt: 1 };
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const original = useStore.getState();
  useStore.setState({ currentUser: { id: 'admin', role: 'admin' }, items: [item], usersById: {}, libraryTree: { globalFolders: [], projects: [] } });
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(FeedBlock, { item, index: 1 })));
    const video = document.querySelector('video');
    assert.ok(video);
    assert.equal(document.querySelector('[data-video-fallback]'), null);
    await act(async () => { video.dispatchEvent(new window.Event('error')); });
    assert.equal(document.querySelector('video'), null);
    const link = document.querySelector('[data-video-fallback="full"] a');
    assert.ok(link);
    assert.match(link.getAttribute('href'), /v1/);
  } finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
});

test('undecodable frame extraction errors carry a typed code', () => {
  const src = fs.readFileSync(new URL('../lib/video-frame.js', import.meta.url), 'utf8');
  assert.match(src, /code: "undecodable"/);
});
