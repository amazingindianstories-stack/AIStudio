import test from "node:test";
import assert from "node:assert/strict";
import { uploadContentType, uploadOriginalReference, uploadFileDirect } from "./client-reference-upload.js";

const file = new Blob([new Uint8Array(9*1024*1024)], { type: 'video/quicktime' });
const session = { version: 1, uploadId: 'session', referenceId: 'session', key: 'uploads/video-reference/key',
  uploadUrl: 'https://storage.googleapis.com/session', byteSize: file.size, contentType: file.type, purpose: 'video-reference' };
const ready = { ...session, state: 'ready', ref: '/api/media/'+session.key };
const reply = (status, body = {}, range) => ({ status, ok: status >= 200 && status < 300,
  json: async () => body, headers: { get: (name) => name === 'Range' ? range : null } });

test('normalizes MIME aliases and missing browser file types', () => {
  assert.equal(uploadContentType({ name: 'photo.JPG', type: 'image/jpg' }), 'image/jpeg');
  assert.equal(uploadContentType({ name: 'portrait.heic' }), 'image/heic');
  assert.equal(uploadContentType({ name: 'voice.m4a' }), 'audio/mp4');
});

test('negotiation rejects without a storage PUT', async () => {
  let requests = 0;
  await assert.rejects(uploadOriginalReference(new Blob(['file'], {type: 'image/png'}), {
    fetchImpl: async () => { requests++; return reply(400, {error: 'INVALID_UPLOAD_CONTENT_TYPE'}); },
  }), /INVALID_UPLOAD_CONTENT_TYPE/);
  assert.equal(requests, 1);
});

test('large MOV is chunked only to storage; init/finalize are small metadata', async () => {
  const calls = [], progress = [];
  const result = await uploadFileDirect(file, 'video-reference', { fetchImpl: async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/uploads/init') return reply(200, session);
    if (url.endsWith('/finalize')) return reply(200, ready);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error', 'reject Location redirects before forwarding original bytes');
    assert.equal(options.headers['Content-Type'], 'video/quicktime');
    assert.ok(options.body instanceof Blob);
    return calls.filter(([url]) => url === session.uploadUrl).length === 1
      ? reply(308, {}, 'bytes=0-8388607') : reply(200);
  }, onProgress: (value) => progress.push(value) });
  assert.equal(result.referenceId, 'session');
  assert.equal(result.ref, ready.ref);
  assert.deepEqual(calls.filter(([url]) => url === session.uploadUrl).map(([, opt]) => opt.headers['Content-Range']),
    [`bytes 0-8388607/${file.size}`, `bytes 8388608-${file.size-1}/${file.size}`]);
  for (const [url, options] of calls.filter(([url]) => url.startsWith('/api/'))) {
    assert.equal(typeof options.body, 'string');
    assert.ok(options.body.length < 1024, url);
    assert.equal(options.body.includes('base64'), false);
  }
  assert.deepEqual(progress.map(value => value.state), ['uploading', 'uploading', 'verifying', 'ready']);
});

test('lost ACK queries the same session range and resumes committed bytes without new object', async () => {
  let puts = 0, init = 0;
  const ranges = [];
  await uploadFileDirect(file, 'video-reference', { retryDelayMs: 0, fetchImpl: async (url, options) => {
    if (url === '/api/uploads/init') { init++; return reply(200, session); }
    if (url.endsWith('/finalize')) return reply(200, ready);
    ranges.push(options.headers['Content-Range']);
    if (++puts === 1) throw new TypeError('Lost ACK');
    if (puts === 2) return reply(308, {}, 'bytes=0-8388607');
    return reply(201);
  } });
  assert.equal(init, 1);
  assert.deepEqual(ranges, [`bytes 0-8388607/${file.size}`, `bytes */${file.size}`,
    `bytes 8388608-${file.size-1}/${file.size}`]);
});

test('expired storage session returns accurate error without allocating another key', async () => {
  let init = 0;
  await assert.rejects(uploadFileDirect(file, 'video-reference', { fetchImpl: async (url) => {
    if (url === '/api/uploads/init') { init++; return reply(200, session); }
    return reply(410);
  } }), /expired/);
  assert.equal(init, 1);
});

test('checksum/signature verification failure preserves error and never returns READY', async () => {
  let storage = 0;
  await assert.rejects(uploadFileDirect(file, 'video-reference', { fetchImpl: async (url) => {
    if (url === '/api/uploads/init') return reply(200, session);
    if (url.endsWith('/finalize')) return reply(422, {error: 'UPLOAD_CHECKSUM_MISMATCH'});
    return ++storage === 1 ? reply(308, {}, 'bytes=0-8388607') : reply(200);
  } }), /UPLOAD_CHECKSUM_MISMATCH/);
});

test('ambiguous finalize retries only finalize using same session', async () => {
  let init = 0, storage = 0, finalize = 0;
  await uploadFileDirect(file, 'video-reference', { retryDelayMs: 0, fetchImpl: async (url) => {
    if (url === '/api/uploads/init') { init++; return reply(200, session); }
    if (url.endsWith('/finalize')) { finalize++; return finalize === 1 ? reply(503) : reply(200, ready); }
    storage++; return storage === 1 ? reply(308, {}, 'bytes=0-8388607') : reply(200);
  } });
  assert.deepEqual([init, storage, finalize], [1, 2, 2]);
});

test('explicit cancellation calls metadata cancel and stops transfer', async () => {
  const controller = new AbortController();
  const urls = [];
  await assert.rejects(uploadFileDirect(file, 'video-reference', { signal: controller.signal,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === '/api/uploads/init') return reply(200, session);
      if (url.endsWith('/cancel')) return reply(200, {state: 'cancelled'});
      controller.abort(new Error('User cancelled')); throw new Error('Cancelled transport');
    },
  }), /User cancelled/);
  assert.ok(urls.includes('/api/uploads/session/cancel'));
  assert.equal(urls.some(url => url.endsWith('/finalize')), false);
});

test('resume reacquires server-held URI and queries offset without browser bearer persistence', async () => {
  const urls = [];
  await uploadFileDirect(file, 'video-reference', { resumeUploadId: 'session', fetchImpl: async (url, options) => {
    urls.push(url);
    if (url.endsWith('/status')) return reply(200, session);
    if (url.endsWith('/finalize')) return reply(200, ready);
    return options.headers['Content-Range'].includes('*') ? reply(308, {}, 'bytes=0-8388607') : reply(200);
  } });
  assert.equal(urls.includes('/api/uploads/init'), false);
  assert.equal(urls.filter(url => url === session.uploadUrl).length, 2);
});

test('rejects untrusted session authorities and invalid chunks before sending original bytes', async () => {
  for (const override of [
    {uploadUrl: 'https://attacker.example/upload'},
    {uploadUrl: 'https://storage.googleapis.com@attacker.example/upload'},
    {uploadUrl: 'https://storage.googleapis.com:444/upload'},
    {chunkBytes: -1}, {chunkBytes: 1}, {chunkBytes: 16*1024*1024},
  ]) {
    let puts = 0;
    await assert.rejects(uploadFileDirect(file, 'video-reference', {fetchImpl: async (_url, options) => {
      if (options.method === 'PUT') puts++;
      return reply(200, {...session, ...override});
    }}), /unsafe storage URL|invalid chunk size/);
    assert.equal(puts, 0);
  }
});

test('resume rejects a different filename before storage bytes or finalize', async () => {
  let calls = 0;
  const named = new Blob(['MOV'], {type:'video/quicktime'});
  Object.defineProperty(named, 'name', {value:'other.mov'});
  await assert.rejects(uploadFileDirect(named, 'video-reference', {resumeUploadId:'session', fetchImpl:async () => {
    calls++;
    return reply(200, {...session, byteSize:named.size, filename:'original.mov'});
  }}), /does not match/);
  assert.equal(calls, 1);
});
