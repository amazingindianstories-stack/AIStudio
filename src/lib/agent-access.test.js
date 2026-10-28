import test from 'node:test';
import assert from 'node:assert/strict';
import { centsToDollarsText, claudeCodeCommand, dollars, dollarsToCents, relativeTime, scopeTitle, verifiedHost, wholeCents } from './agent-access.js';

test('dollar amounts parse to whole cents and refuse anything else', () => {
  assert.equal(dollarsToCents('10'), 1000);
  assert.equal(dollarsToCents('$1,000.25'), 100025);
  assert.equal(dollarsToCents(' 0.5 '), 50);
  assert.equal(dollarsToCents('0.10'), 10);
  for (const text of ['', '0', '0.00', '-1', '1.234', 'ten', '1e3', null]) assert.equal(dollarsToCents(text), null, String(text));
  assert.equal(centsToDollarsText(1000), '10');
  assert.equal(centsToDollarsText(1050), '10.50');
  assert.equal(dollars(200000), '$2,000.00');
});

test('auto-approve cents are whole numbers within the limit', () => {
  assert.equal(wholeCents('0', 100), 0);
  assert.equal(wholeCents('100', 100), 100);
  for (const text of ['101', '2.5', '-1', '', 'x']) assert.equal(wholeCents(text, 100), null, text);
});

test('labels, times and the Claude Code command', () => {
  assert.equal(scopeTitle('veevee.generate'), 'Create images and videos');
  assert.equal(scopeTitle('unknown.scope'), 'unknown.scope');
  const now = Date.UTC(2026, 9, 28, 12);
  assert.equal(relativeTime(null, now), 'Never used');
  assert.equal(relativeTime(now - 30_000, now), 'Used just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), 'Used 5 min ago');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), 'Used 3 h ago');
  assert.equal(claudeCodeCommand('https://veevee.ai/mcp', 'vv_pat_x'),
    'claude mcp add --transport http veevee https://veevee.ai/mcp --header "Authorization: Bearer vv_pat_x"');
  assert.equal(verifiedHost({ verifiedUrl: 'https://claude.ai/oauth/claude-code-client-metadata' }), 'claude.ai');
  assert.equal(verifiedHost({ verifiedUrl: null }), null);
});
