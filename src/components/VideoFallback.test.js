import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoFallback } from './VideoFallback.jsx';
import { FeedBlock } from './ConversationPanel.jsx';
import { useStore } from '../lib/store.js';
import { MediaCard } from './MediaCard.jsx';
import { __setMediaResolverFetch } from '../lib/media-resolver.js';
import { loadVideo } from '../lib/video-frame.js';

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

test('a library tile whose video cannot be decoded shows the compact fallback with its duration', async () => {
  const item = { id: 'v2', kind: 'video', status: 'succeeded', url: '/api/media/y.mov', filename: 'y.mov', prompt: 'p', model: 'Seedance 2.5', aspectRatio: '16:9', duration: 5, createdAt: 1 };
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: undefined });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  __setMediaResolverFetch(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  const original = useStore.getState();
  useStore.setState({ currentUser: { id: 'admin', role: 'admin' }, items: [item], selectedIds: [], usersById: {}, libraryTree: { globalFolders: [], projects: [] } });
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(MediaCard, { item, index: 1 })));
    assert.equal(document.querySelector('[data-video-fallback]'), null);
    for (let attempt = 0; attempt < 5 && !document.querySelector('[data-video-fallback]'); attempt += 1) {
      const video = document.querySelector('video');
      assert.ok(video);
      await act(async () => { video.dispatchEvent(new window.Event('error')); });
    }
    const fallback = document.querySelector('[data-video-fallback="compact"]');
    assert.ok(fallback, 'the tile shows the compact fallback');
    assert.match(fallback.textContent, /5s/);
    assert.match(fallback.textContent, /Preview unavailable\. Open to download the original\./);
  } finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
});

test('feed swaps a video that fails to decode for the fallback with a download link', async () => {
  const item = { id: 'v1', kind: 'video', status: 'succeeded', url: '/api/media/x.mov', filename: 'x.mov', prompt: 'p', model: 'Seedance 2.5', aspectRatio: '16:9', createdAt: 1 };
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    // The frame is on screen, so a posterless clip mounts its <video>.
    IntersectionObserver: class { constructor(cb) { this.cb = cb; } observe(target) { this.cb([{ target, isIntersecting: true }]); } unobserve() {} disconnect() {} } });
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

test('a video the browser cannot decode rejects with a typed undecodable error', async () => {
  const dom = new JSDOM('', { url: 'http://localhost', virtualConsole: new VirtualConsole() });
  const prior = globalThis.document;
  const videos = [];
  const create = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tag) => { const el = create(tag); if (tag === 'video') videos.push(el); return el; };
  globalThis.document = dom.window.document;
  try {
    const pending = loadVideo('/api/media/x.mov');
    assert.equal(videos.length, 1);
    videos[0].dispatchEvent(new dom.window.Event('error'));
    await assert.rejects(pending, (err) => err.code === 'undecodable' && /could not decode/.test(err.message));
  } finally { globalThis.document = prior; dom.window.close(); }
});
