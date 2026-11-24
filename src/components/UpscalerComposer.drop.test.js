import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { UpscalerComposer } from './UpscalerComposer.jsx';
import { VEEVEE_ASSET_MIME } from '../lib/asset-drag-contract.js';
import { useStore } from '../lib/store.js';
import { useNotices } from '../lib/notify.js';

async function withDom(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const names = ['window', 'document', 'HTMLElement', 'React', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id) });
  const root = createRoot(document.querySelector('#root'));
  try { await run(root); } finally { await act(async () => root.unmount()); Object.assign(globalThis, prior); dom.window.close(); }
}

const dropOf = (item) => {
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  event.dataTransfer = { getData: (type) => (type === VEEVEE_ASSET_MIME ? JSON.stringify({ ids: [item.id], items: [item], primaryId: item.id }) : ''), types: [VEEVEE_ASSET_MIME], files: [], dropEffect: 'copy' };
  return event;
};

test('dropping an unfinished or URL-less image generation is refused with a message and sets no source (FE-017)', async () => {
  useNotices.setState({ notices: [] });
  const before = useStore.getState().upscalerImage;
  await withDom(async (root) => {
    await act(async () => root.render(React.createElement(UpscalerComposer)));
    const zones = [...document.querySelectorAll("div.mb-4")];
    for (const item of [{ id: 'q', kind: 'image', status: 'queued', url: '/api/media/q.png' }, { id: 'n', kind: 'image', status: 'succeeded' }]) {
      await act(async () => { for (const zone of zones) zone.dispatchEvent(dropOf(item)); });
      assert.equal(useStore.getState().upscalerImage, before);
      assert.ok(useNotices.getState().notices.some((n) => /finish first/.test(n.text)));
      useNotices.setState({ notices: [] });
    }
    await act(async () => { zones.forEach((zone) => zone.dispatchEvent(dropOf({ id: 'ok', kind: 'image', status: 'succeeded', url: '/api/media/ok.png' }))); });
    assert.equal(useStore.getState().upscalerImage?.url, '/api/media/ok.png');
  });
  useStore.setState({ upscalerImage: before });
});
