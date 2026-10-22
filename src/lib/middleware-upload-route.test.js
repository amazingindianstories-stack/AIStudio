import test from 'node:test';
import assert from 'node:assert/strict';
import { middleware } from '../middleware.js';
function request(path, sessionValue, headers = {}) {
  return { url: `https://www.veevee.ai${path}`, method: 'POST', headers: new Headers(headers), nextUrl: {
    pathname: path, clone: () => new URL(`https://www.veevee.ai${path}`),
  }, cookies: { get: () => sessionValue ? { value: sessionValue } : undefined } };
}
test('presign and dotted media paths use Django for both anonymous and session requests', async () => {
  const old = process.env.DJANGO_API_ORIGIN, oldIngress = process.env.GOAL4_PRIVATE_INGRESS_SECRET;
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = 'test-ingress-secret-0123456789abcdef0123456789abcdef';
  try {
    for (const session of [undefined, 'session-token']) for (const path of ['/api/uploads/presign', '/api/media/video/a.mov']) {
      // A caller-supplied ingress header must be replaced by the server-only value.
      const response = await middleware(request(path, session, { 'x-veevee-g4-ingress': 'forged' }));
      assert.equal(response.headers.get('x-middleware-rewrite'), `https://django.example${path}`);
      assert.equal(response.headers.get('x-middleware-request-x-veevee-g4-ingress'), process.env.GOAL4_PRIVATE_INGRESS_SECRET);
    }
  } finally {
    if (old === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old;
    if (oldIngress === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = oldIngress;
  }
});
test('missing private ingress fails closed instead of forwarding unauthenticated transport', async () => {
  const old = process.env.DJANGO_API_ORIGIN, oldIngress = process.env.GOAL4_PRIVATE_INGRESS_SECRET;
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = 'too-short';
  try {
    const response = await middleware(request('/api/uploads/presign'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-middleware-rewrite'), null);
  } finally {
    if (old === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old;
    if (oldIngress === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = oldIngress;
  }
});
test('missing backend never falls through to retained Node routes', async () => {
  const old = process.env.DJANGO_API_ORIGIN;
  delete process.env.DJANGO_API_ORIGIN;
  try {
    const response = await middleware(request('/api/uploads/presign'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'BACKEND_ROUTING_UNAVAILABLE' });
  } finally { if (old !== undefined) process.env.DJANGO_API_ORIGIN = old; }
});
test('page convenience redirect allows stale cookies to reach login', async () => {
  assert.equal((await middleware(request('/login', 'stale'))).headers.get('x-middleware-next'), '1');
  assert.equal((await middleware(request('/admin'))).headers.get('location'), 'https://www.veevee.ai/login?next=%2Fadmin');
});
