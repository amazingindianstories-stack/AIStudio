import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { ViewerMedia } from './ViewerMedia.jsx';

const video = { id: 'gen-mov-1', kind: 'video', url: '/api/media/outputs/clip.mov', poster: '/api/media/outputs/clip.jpg', filename: 'clip.mov', prompt: 'p' };

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
    fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }) });
  const root = createRoot(document.querySelector('#root'));
  try { await run({ root, render: (props) => act(async () => root.render(React.createElement(ViewerMedia, props))) }); }
  finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}

test('a native MOV the browser cannot decode reports unplayable, then offers the original as a download', async () => {
  await withDom(async ({ render }) => {
    const unplayable = [];
    const props = { item: video, source: 'grid', unplayableUrl: null, onUnplayable: (url) => unplayable.push(url) };
    await render(props);
    const player = document.querySelector('video[data-detail-video]');
    assert.ok(player, 'the original is played directly, not a preview transcode');
    await act(async () => { player.dispatchEvent(new window.Event('error')); });
    assert.deepEqual(unplayable, [video.url]);

    await render({ ...props, unplayableUrl: video.url });
    assert.equal(document.querySelector('video'), null);
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Download original');
    assert.ok(link, 'Download original link is shown');
    assert.match(link.getAttribute('href'), /^\/api\/generations\/gen-mov-1\/download/);
    assert.equal(link.getAttribute('download'), 'clip.mov');
  });
});
