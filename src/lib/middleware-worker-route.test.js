import test from 'node:test';
import assert from 'node:assert/strict';
import { middleware } from '../middleware.js';
import { readFileSync } from 'node:fs';
test('machine and retired execution paths receive the same Django transport', () => {
  const old = process.env.DJANGO_API_ORIGIN;
  process.env.DJANGO_API_ORIGIN = 'https://django.example';
  try {
    for (const path of ['/api/queue/execute', '/api/depth-worker/claim', '/api/cron/recover', '/api/media-exports/worker/claim']) {
      const response = middleware({ url: `https://frontend.example${path}`, method: 'POST', nextUrl: { pathname: path } });
      assert.equal(response.headers.get('x-middleware-rewrite'), `https://django.example${path}`);
    }
  } finally { if (old === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = old; }
  assert.doesNotMatch(readFileSync('src/middleware.js', 'utf8'), /from ["'].*(?:auth|db|session|provider)/);
});
