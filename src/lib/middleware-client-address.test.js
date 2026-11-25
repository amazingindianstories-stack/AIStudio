import test from 'node:test';
import assert from 'node:assert/strict';
import { middleware, clientAddress } from '../middleware.js';

const SECRET = 'test-ingress-secret-0123456789abcdef0123456789abcdef';

function request(path, headers = {}) {
  return { url: `https://www.veevee.ai${path}`, method: 'POST', headers: new Headers(headers), nextUrl: {
    pathname: path, clone: () => new URL(`https://www.veevee.ai${path}`),
  }, cookies: { get: () => undefined } };
}

async function withBackend(run) {
  const old = { origin: process.env.DJANGO_API_ORIGIN, secret: process.env.GOAL4_PRIVATE_INGRESS_SECRET };
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = SECRET;
  try { await run(); } finally {
    if (old.origin === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old.origin;
    if (old.secret === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = old.secret;
  }
}

test('the client address is the one Vercel reports, never a caller-writable header', () => {
  assert.equal(clientAddress(new Headers({ 'x-vercel-forwarded-for': '8.8.8.8' })), '8.8.8.8');
  assert.equal(clientAddress(new Headers({ 'x-vercel-forwarded-for': ' 8.8.8.8 , 1.1.1.1' })), '8.8.8.8');
  assert.equal(clientAddress(new Headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9' })), null);
  assert.equal(clientAddress(new Headers()), null);
});

test('the forwarded request carries Vercel\'s client address and drops caller-supplied address headers', async () => {
  await withBackend(async () => {
    for (const path of ['/api/auth/login', '/api/oauth/token']) {
      const response = await middleware(request(path, {
        'x-vercel-forwarded-for': '8.8.8.8',
        'x-veevee-client-ip': '6.6.6.6',
        'x-veevee-client-ip-proof': 'v1.1.forged',
      }));
      assert.equal(response.headers.get('x-middleware-request-x-veevee-client-ip'), '8.8.8.8');
      assert.equal(response.headers.get('x-middleware-request-x-veevee-client-ip-proof'), null);
    }
  });
});

test('without a Vercel client address no address header is forwarded, even if the caller sent one', async () => {
  await withBackend(async () => {
    const response = await middleware(request('/api/auth/login', {
      'x-veevee-client-ip': '6.6.6.6', 'x-veevee-client-ip-proof': 'v1.1.forged', 'x-forwarded-for': '7.7.7.7',
    }));
    assert.equal(response.headers.get('x-middleware-rewrite'), 'https://django.example/api/auth/login');
    assert.equal(response.headers.get('x-middleware-request-x-veevee-client-ip'), null);
    assert.equal(response.headers.get('x-middleware-request-x-veevee-client-ip-proof'), null);
  });
});
