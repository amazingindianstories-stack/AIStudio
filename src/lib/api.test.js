import test from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE, apiUrl, apiFetch } from './api.js';
import { loginNextPath } from './login-next.js';
test('browser API transport stays same-origin and rejects endpoint escapes', () => {
  assert.equal(API_BASE, '');
  assert.equal(apiUrl('/api/history?q=a%20b'), '/api/history?q=a%20b');
  for (const path of ['https://elsewhere.example/api/x', '//elsewhere.example/api/x', '/api/../login', '/api/%2e%2e/login', '/api/\\elsewhere', '/login']) assert.throws(() => apiUrl(path));
});
test('browser API transport includes session cookies', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/auth/me'); assert.equal(options.credentials, 'include'); return Response.json({ user: null });
  });
  assert.equal((await apiFetch('/api/auth/me')).status, 200);
});

test('post-login destinations stay within this frontend origin', () => {
  assert.equal(loginNextPath('/admin?tab=users#top'), '/admin?tab=users#top');
  assert.equal(loginNextPath('/'), '/');
  for (const value of [null, '', 'https://untrusted.example', '//untrusted.example', '/\\untrusted.example', '/\nuntrusted.example', 'javascript:alert(1)']) assert.equal(loginNextPath(value), '/');
});
