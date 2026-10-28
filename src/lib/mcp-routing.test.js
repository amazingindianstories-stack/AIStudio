import test from 'node:test';
import assert from 'node:assert/strict';
import { config, createMiddleware } from '../middleware.js';
import { mcpDestination } from './backend-routing.js';

const INGRESS = 'test-ingress-secret-0123456789abcdef0123456789abcdef';

function request(url, { method = 'POST', headers = {} } = {}) {
  const parsed = new URL(url);
  return { url, method, headers: new Headers(headers), nextUrl: { pathname: parsed.pathname }, cookies: { get: () => undefined } };
}

async function withMcp(run, origin = 'https://mcp.example') {
  const saved = { MCP_API_ORIGIN: process.env.MCP_API_ORIGIN, GOAL4_PRIVATE_INGRESS_SECRET: process.env.GOAL4_PRIVATE_INGRESS_SECRET };
  if (origin) process.env.MCP_API_ORIGIN = origin; else delete process.env.MCP_API_ORIGIN;
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = INGRESS;
  try { await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// NextResponse.rewrite carries the overridden request headers as x-middleware-request-<name>.
const forwarded = (response, name) => response.headers.get(`x-middleware-request-${name}`);

test('only /mcp routes to the MCP origin, keeping the query', () => {
  const configured = { origin: 'https://mcp.example' };
  assert.equal(mcpDestination('https://veevee.ai/mcp?x=1', configured).href, 'https://mcp.example/mcp?x=1');
  for (const path of ['/mcp/', '/mcp/tools', '/api/mcp/me', '/mcpx']) assert.equal(mcpDestination(`https://veevee.ai${path}`, configured), null);
  assert.throws(() => mcpDestination('https://veevee.ai/mcp', {}));
  assert.throws(() => mcpDestination('https://veevee.ai/mcp', { origin: 'http://mcp.example' }));
  assert.throws(() => mcpDestination('https://veevee.ai/mcp', { origin: 'https://veevee.ai' }));
  assert.ok(config.matcher.includes('/mcp'));
});

test('/mcp is a no-store rewrite with the server-only ingress header and no cookies', async () => {
  await withMcp(async () => {
    const middleware = createMiddleware(async () => ({ enabled: false, available: true }));
    const response = await middleware(request('https://veevee.ai/mcp', { headers: {
      authorization: 'Bearer vv_pat_x', cookie: 'veevee_session=s', 'x-veevee-g4-ingress': 'forged', 'x-veevee-maintenance': '1',
      'x-vercel-protection-bypass': 'b' } }));
    assert.equal(response.headers.get('x-middleware-rewrite'), 'https://mcp.example/mcp');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('location'), null);
    assert.equal(forwarded(response, 'x-veevee-g4-ingress'), INGRESS);
    assert.equal(forwarded(response, 'authorization'), 'Bearer vv_pat_x');
    for (const name of ['cookie', 'x-veevee-maintenance', 'x-vercel-protection-bypass']) assert.equal(forwarded(response, name), null, name);
  });
});

test('maintenance forwards a header instead of answering 503, for every method', async () => {
  await withMcp(async () => {
    const middleware = createMiddleware(async () => ({ enabled: true, available: true }));
    for (const method of ['POST', 'GET', 'DELETE']) {
      const response = await middleware(request('https://veevee.ai/mcp', { method }));
      assert.equal(response.status, 200, method);
      assert.equal(response.headers.get('x-middleware-rewrite'), 'https://mcp.example/mcp');
      assert.equal(forwarded(response, 'x-veevee-maintenance'), '1');
    }
  });
});

test('an unconfigured MCP origin fails closed without reaching Django or the login page', async () => {
  await withMcp(async () => {
    const response = await createMiddleware(async () => ({ enabled: false, available: true }))(request('https://veevee.ai/mcp'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'MCP_ROUTING_UNAVAILABLE' });
    assert.equal(response.headers.get('x-middleware-rewrite'), null);
  }, null);
});
