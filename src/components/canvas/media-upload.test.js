import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadImageFile, uploadImageFiles } from './CanvasSurface.jsx';

const file = new Blob([new Uint8Array(16)], { type: 'image/png' });
file.name = 'big.png';
const reply = (status, body) => ({ status, ok: status < 300, json: async () => body, headers: { get: () => null } });

async function withFetch(upload, run) {
  const prior = { fetch: globalThis.fetch, Image: globalThis.Image, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.fetch = async (url) => (String(url) === '/api/uploads/init'
    ? reply(200, { uploadId: 'u', referenceId: 'ref', state: 'ready' })
    : upload(url));
  globalThis.Image = class { set src(_) { this.naturalWidth = 4; this.naturalHeight = 3; queueMicrotask(() => this.onload()); } };
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
  try { await run(); } finally {
    globalThis.fetch = prior.fetch; globalThis.Image = prior.Image;
    URL.createObjectURL = prior.create; URL.revokeObjectURL = prior.revoke;
  }
}

test('uploadImageFile throws the server message when registration is refused', async () => {
  await withFetch(() => reply(413, { error: 'Image exceeds 25 MB' }), async () => {
    await assert.rejects(uploadImageFile(file, 'b1'), /Image exceeds 25 MB/);
  });
});

test('uploadImageFile falls back to the status when the body has no message', async () => {
  await withFetch(() => ({ status: 403, ok: false, json: async () => { throw new Error('no body'); } }), async () => {
    await assert.rejects(uploadImageFile(file, 'b1'), /Upload failed \(403\)/);
  });
});

test('uploadImageFiles reports lastError alongside the failed count', async () => {
  await withFetch(() => reply(413, { error: 'Image exceeds 25 MB' }), async () => {
    const result = await uploadImageFiles([file], 'b1');
    assert.equal(result.failed, 1);
    assert.deepEqual(result.images, []);
    assert.equal(result.lastError, 'Image exceeds 25 MB');
  });
});
