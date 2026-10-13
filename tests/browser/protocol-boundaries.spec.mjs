import { test, expect } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';

function protocolRequest(baseURL, path, cookie, chunks, { chunked = true, origin = true } = {}) {
  const target = new URL(path, baseURL);
  if (target.hostname !== '127.0.0.1') throw new Error('Protocol probe requires isolated loopback gateway');
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method: 'POST', headers: {
      Cookie: cookie, 'Content-Type': 'application/json',
      ...(origin ? { Origin: process.env.E2E_BASE_URL } : {}),
      ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(chunks.join('')) }),
    } }, response => {
      const body = [];
      response.on('data', part => body.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(body).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Chunked request timed out')));
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('gateway preserves chunked JSON without Content-Length and rejects encoded protected media paths', async ({ context, baseURL }, testInfo) => {
  const payload = Buffer.from(JSON.stringify({ uid: 'e33e1832-9e29-427f-af61-796b842a4b37', ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  const cookie = `veevee_session=${payload}.${signature}`;
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
  const before = await (await context.request.get('/api/projects')).json();
  const chunks = ['{"op":"create', 'Project","name":""}'];
  const headerless = await protocolRequest(baseURL, '/api/projects', cookie, chunks, { origin: false });
  expect(headerless.status).toBe(403);
  expect(JSON.parse(headerless.body)).toEqual({ error: 'FORBIDDEN_ORIGIN' });
  const control = await protocolRequest(baseURL, '/api/projects', cookie, chunks, { chunked: false });
  expect(control.status).toBe(400);
  expect(JSON.parse(control.body)).toEqual({ error: 'Name required.' });
  const direct = await protocolRequest(process.env.DJANGO_API_ORIGIN, '/api/projects', cookie, chunks);
  const result = await protocolRequest(baseURL, '/api/projects', cookie, chunks);
  await testInfo.attach('chunked-protocol-diagnostic', { body: Buffer.from(JSON.stringify({ control, direct, gateway: result }, null, 2)), contentType: 'application/json' });
  console.log('Chunked protocol diagnostic:', JSON.stringify({ control, direct, gateway: result }));
  expect(direct.status).toBe(400);
  expect(JSON.parse(direct.body)).toEqual({ error: 'Name required.' });
  expect(result.status).toBe(400);
  // Empty/lost bodies produce "Unknown op."; this proves both chunks survived.
  expect(JSON.parse(result.body)).toEqual({ error: 'Name required.' });
  expect(await (await context.request.get('/api/projects')).json()).toEqual(before);
  for (const path of [
    '/api/media/settings%2Ftoken', '/api/media/settings%252Ftoken',
    '/api/media/uploads/%252e%252e/settings/token', '/api/media/uploads/%255ctoken',
  ]) {
    const response = await context.request.get(path);
    expect(response.status()).toBe(404);
    expect((await response.body()).toString()).not.toContain('veevee_session');
  }
});
