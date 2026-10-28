import test from 'node:test';
import assert from 'node:assert/strict';
import { config, middleware } from '../middleware.js';
import { djangoDestination } from './backend-routing.js';

const configured = { origin: 'https://django.example' };

function request(url, sessionValue) {
  const parsed = new URL(url);
  return { url, method: 'GET', headers: new Headers(), nextUrl: { pathname: parsed.pathname },
    cookies: { get: () => sessionValue ? { value: sessionValue } : undefined } };
}

async function withBackend(run) {
  const old = process.env.DJANGO_API_ORIGIN, oldIngress = process.env.GOAL4_PRIVATE_INGRESS_SECRET;
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = 'test-ingress-secret-0123456789abcdef0123456789abcdef';
  try { await run(); } finally {
    if (old === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old;
    if (oldIngress === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = oldIngress;
  }
}

test('OAuth discovery documents route to their Django handlers and nothing else under .well-known does', () => {
  assert.equal(djangoDestination('https://veevee.ai/.well-known/oauth-authorization-server', 'GET', configured).href,
    'https://django.example/api/oauth/authorization-server');
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal(djangoDestination(`https://veevee.ai${path}`, 'GET', configured).href, 'https://django.example/api/oauth/protected-resource');
  }
  for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-protected-resource/other', '/.well-known/constructor']) {
    assert.equal(djangoDestination(`https://veevee.ai${path}`, 'GET', configured), null);
  }
});

test('discovery documents are public rewrites with the server-only ingress header', async () => {
  await withBackend(async () => {
    const response = await middleware(request('https://veevee.ai/.well-known/oauth-protected-resource/mcp'));
    assert.equal(response.headers.get('x-middleware-rewrite'), 'https://django.example/api/oauth/protected-resource');
    assert.equal(response.headers.get('location'), null);
  });
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.ok(config.matcher.includes(path), path);
  }
});

test('signing in from the consent page keeps the whole authorization request', async () => {
  const query = '?response_type=code&client_id=vvc_abc&state=x%26y&code_challenge=c&code_challenge_method=S256';
  const response = await middleware(request(`https://veevee.ai/oauth/authorize${query}`));
  const location = new URL(response.headers.get('location'));
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('next'), `/oauth/authorize${query}`);
});
