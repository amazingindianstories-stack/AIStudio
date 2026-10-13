import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { djangoDestination, fetchDjangoSession } from './backend-routing.js';
const configured = { origin: 'https://django.example', ingressSecret: 'synthetic-ingress-'.repeat(4) };

test('every API method and path transports to Django with exact repeated queries', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    for (const path of ['/api', '/api/auth/me', '/api/history', '/api/canvas-boards/a', '/api/media/masters/a.mov', '/api/queue/execute', '/api/unknown']) {
      assert.equal(djangoDestination(`https://frontend.example${path}?q=first&q=second`, method, configured).href,
        `https://django.example${path}?q=first&q=second`);
    }
  }
});
test('missing configuration fails closed and page paths remain frontend-owned', () => {
  assert.throws(() => djangoDestination('https://frontend.example/api/settings', 'GET', {}));
  for (const path of ['/', '/login', '/admin', '/apiary']) assert.equal(djangoDestination(`https://frontend.example${path}`, 'GET', {}), null);
});
test('routing rejects credentials, loops, non-origin URLs and insecure remote origins', () => {
  for (const origin of ['http://django.example', 'https://user:pass@django.example', 'https://frontend.example', 'https://django.example/prefix', 'https://django.example/?x=1', 'https://django.example/#hash']) {
    assert.throws(() => djangoDestination('https://frontend.example/api/settings', 'GET', { origin }));
  }
});
test('local qualification requires explicit loopback permission', () => {
  const request = 'https://frontend.example/api/settings';
  assert.throws(() => djangoDestination(request, 'GET', { origin: 'http://127.0.0.1:8000' }));
  assert.equal(djangoDestination(request, 'GET', { origin: 'http://127.0.0.1:8000', allowLocal: '1' }).port, '8000');
  assert.throws(() => djangoDestination(request, 'GET', { origin: 'http://remote.example', allowLocal: '1' }));
});
test('server pages read the authoritative session with forwarded cookies and no cache', async () => {
  const user = { id: 'user', role: 'admin' };
  assert.deepEqual(await fetchDjangoSession('veevee_session=opaque', configured, async (url, options) => {
    assert.equal(url, 'https://django.example/api/auth/me');
    assert.deepEqual(options.headers, { Cookie: 'veevee_session=opaque', 'x-veevee-g4-ingress': configured.ingressSecret });
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    return Response.json({ user });
  }), user);
  assert.equal(await fetchDjangoSession('', configured, async () => new Response('', { status: 401 })), null);
  await assert.rejects(fetchDjangoSession('', configured, async () => new Response('', { status: 503 })), /unavailable/);
});

// The inventory is the frozen pre-migration method surface, independent of
// whether a particular Django endpoint is still being qualified.
test('all inventoried API contracts are routed to Django', () => {
  const { methods } = JSON.parse(readFileSync('docs/django-migration/local-implementation.json', 'utf8'));
  assert.ok(methods.length >= 85);
  for (const entry of methods) {
    const path = entry.path.replace(/\[\.\.\.([^\]]+)\]/g, 'one/two.mov').replace(/\[([^\]]+)\]/g, 'contract-id');
    assert.equal(djangoDestination(`https://frontend.example${path}`, entry.method, configured).pathname, path);
  }
});

test('server session ingress fails closed and strips Vercel access cookies', async () => {
  let calls = 0;
  const fetchMock = async (_url, options) => {
    calls++;
    assert.equal(options.headers['x-veevee-g4-ingress'], configured.ingressSecret);
    assert.equal(options.headers.Cookie.trim(), 'veevee_session=opaque');
    assert.equal(options.headers['x-vercel-protection-bypass'], undefined);
    return Response.json({user: {id: 'synthetic'}});
  };
  for (const ingressSecret of [undefined, '', 'short', 123]) {
    await assert.rejects(fetchDjangoSession('', {...configured, ingressSecret}, fetchMock), /ingress/);
  }
  assert.equal(calls, 0);
  await assert.rejects(fetchDjangoSession('', {...configured, origin: undefined}, fetchMock), /origin/);
  assert.equal(calls, 0);
  await fetchDjangoSession('_vercel_jwt=private; veevee_session=opaque; _vercel_protection_bypass=private', {...configured, headers: {'x-veevee-g4-ingress': 'caller-controlled'}}, fetchMock);
  assert.equal(calls, 1);
});
