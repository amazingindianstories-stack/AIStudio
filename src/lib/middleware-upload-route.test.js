import test from 'node:test';
import assert from 'node:assert/strict';
import { middleware } from '../middleware.js';
function request(path, sessionValue) {
  return { url: `https://www.veevee.ai${path}`, method: 'POST', nextUrl: {
    pathname: path, clone: () => new URL(`https://www.veevee.ai${path}`),
  }, cookies: { get: () => sessionValue ? { value: sessionValue } : undefined } };
}
test('presign and dotted media paths use Django for both anonymous and session requests', () => {
  const old = process.env.DJANGO_API_ORIGIN;
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  try {
    for (const session of [undefined, 'session-token']) for (const path of ['/api/uploads/presign', '/api/media/video/a.mov']) {
      const response = middleware(request(path, session));
      assert.equal(response.headers.get('x-middleware-rewrite'), `https://django.example${path}`);
    }
  } finally { if (old === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old; }
});
test('missing backend never falls through to retained Node routes', async () => {
  const old = process.env.DJANGO_API_ORIGIN;
  delete process.env.DJANGO_API_ORIGIN;
  try {
    const response = middleware(request('/api/uploads/presign'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'BACKEND_ROUTING_UNAVAILABLE' });
  } finally { if (old !== undefined) process.env.DJANGO_API_ORIGIN = old; }
});
test('page convenience redirect allows stale cookies to reach login', () => {
  assert.equal(middleware(request('/login', 'stale')).headers.get('x-middleware-next'), '1');
  assert.equal(middleware(request('/admin')).headers.get('location'), 'https://www.veevee.ai/login?next=%2Fadmin');
});
