import { test, expect } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const LIMIT = 32 * 1024 * 1024;
const PREFIX = Buffer.from('{"op":"createProject","name":"","padding":"');
const SUFFIX = Buffer.from('"}');
const PAD = Buffer.alloc(64 * 1024, 0x20);

// Send bounded chunks and honor socket backpressure rather than constructing
// multiple 32 MiB strings. The deadline covers connect, writes and response.
function ingressRequest(base, cookie, size, chunked) {
  const target = new URL('/api/projects', base);
  if (process.env.MIGRATION_TEST_ISOLATED !== '1' || !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Loopback isolated ingress only');
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const req = httpRequest(target, { method: 'POST', headers: {
      Cookie: cookie, Origin: process.env.E2E_BASE_URL, 'Content-Type': 'application/json',
      ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': size }),
    } }, response => {
      responseStarted = true;
      const parts = [];
      let bytes = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > 65536) req.destroy(new Error('Unexpected oversized error response'));
        else parts.push(part);
      });
      response.on('error', fail);
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode, body: Buffer.concat(parts).toString(), contentType: response.headers['content-type'] });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Ingress operation exceeded 30 seconds')), 30000);
    function fail(error) { clearTimeout(timer); reject(error); }
    req.on('error', error => { if (!responseStarted) fail(error); });
    let remaining = size - PREFIX.length - SUFFIX.length, stage = 0;
    function pump() {
      while (!responseStarted && !req.destroyed) {
        let part;
        if (stage === 0) { part = PREFIX; stage = 1; }
        else if (remaining > 0) { part = PAD.subarray(0, Math.min(PAD.length, remaining)); remaining -= part.length; }
        else if (stage === 1) { part = SUFFIX; stage = 2; }
        else { req.end(); return; }
        if (!req.write(part)) { req.once('drain', pump); return; }
      }
    }
    pump();
  });
}

test('local 32MiB ingress below exact above boundaries preserve framing and create no records', async ({ context, baseURL }, info) => {
  test.setTimeout(420000);
  const payload = Buffer.from(JSON.stringify({ uid: 'e33e1832-9e29-427f-af61-796b842a4b37', ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  const cookie = `veevee_session=${payload}.${signature}`;
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
  // Establish default-project initialization before taking the no-effects snapshot.
  expect((await context.request.get('/api/projects')).ok()).toBeTruthy();
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const snapshot = () => db`SELECT
    (SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM folders) AS folders,
    (SELECT count(*) FROM generations) AS generations,
    (SELECT count(*) FROM activity_logs) AS activity_logs`;
  const before = await snapshot();
  const evidence = [];
  try {
    for (const [transport, origin] of [['gunicorn', process.env.DJANGO_API_ORIGIN], ['next-gateway', baseURL]]) {
      for (const chunked of [false, true]) {
        for (const delta of [-1, 0, 1]) {
          const result = await ingressRequest(origin, cookie, LIMIT + delta, chunked);
          evidence.push({ transport, framing: chunked ? 'chunked' : 'content-length', bytes: LIMIT + delta, ...result });
          // Retain the actual contract even if an assertion below fails.
          await info.attach(`ingress-${transport}-${chunked}-${delta}`, { body: Buffer.from(JSON.stringify(evidence.at(-1))), contentType: 'application/json' });
          if (delta <= 0) {
            expect(result.status).toBe(400);
            expect(JSON.parse(result.body)).toEqual({ error: 'Name required.' });
          } else if (transport === 'gunicorn' && chunked) {
            expect(result.status).toBe(413);
            expect(JSON.parse(result.body)).toEqual({ error: 'REQUEST_BODY_TOO_LARGE' });
          } else {
            // Django's fixed-length RequestDataTooBig yields400; the chunked
            // gateway can preserve413 or deliver Django's bounded fixed path.
            expect([400, 413]).toContain(result.status);
            expect(result.body).not.toContain('Name required.');
          }
          expect(await snapshot()).toEqual(before);
        }
      }
    }
  } finally { await db.end(); }
});
