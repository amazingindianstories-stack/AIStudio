import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Offline native-resumable protocol probe. Distinct loopback authorities collect
// only synthetic bytes; never load checkout credentials or contact cloud hosts.
const captured = [];
const sink = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let bytes = 0;
  for await (const chunk of req) bytes += chunk.length;
  captured.push(bytes);
  res.end();
});
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
const source = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  if (req.url === '/') { res.end('<html>Offline upload protocol</html>'); return; }
  res.statusCode = req.url === '/308' ? 308 : 307;
  if (res.statusCode === 308) res.setHeader('Range', 'bytes=0-262143');
  else res.setHeader('Location', `http://127.0.0.1:${sink.address().port}/capture`);
  res.end();
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, env: {} });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${source.address().port}/`);
  const results = await page.evaluate(async () => {
    const results = [];
    for (const redirect of ['follow', 'error', 'manual']) {
      for (const code of [308, 307]) {
        try {
          const response = await fetch(`/${code}`, { method: 'PUT', redirect,
            body: new Uint8Array(262144), credentials: 'omit' });
          results.push({ redirect, code, status: response.status, range: response.headers.get('Range') });
        } catch { results.push({ redirect, code, rejected: true }); }
      }
    }
    return results;
  });
  const error308 = results.find(value => value.redirect === 'error' && value.code === 308);
  assert.equal(error308.status, 308);
  assert.equal(error308.range, 'bytes=0-262143');
  assert.equal(results.find(value => value.redirect === 'error' && value.code === 307).rejected, true);
  assert.deepEqual(captured, [262144]); // Only follow leaked synthetic bytes.
  console.log(JSON.stringify({ browser: 'Chromium', results, redirectCaptureBytes: captured,
    conclusion: 'redirect:error preserves no-Location308 and rejects307 before body forwarding' }, null, 2));
} finally {
  await browser.close();
  await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => sink.close(resolve))]);
}
