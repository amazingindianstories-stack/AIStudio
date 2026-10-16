import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Django owns every API route, provider call, database write and cron. The
// frontend is transport only; these checks keep a Node backend from returning.

test('retired Node backend paths stay absent', () => {
  for (const name of ['src/app/api', 'src/lib/providers', 'src/worker', 'src/lib/db.js', 'src/lib/schema.js', 'drizzle.config.js']) {
    assert.equal(existsSync(name), false, `Retired Node backend path restored: ${name}`);
  }
});

test('package.json carries no backend dependencies or backend commands', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.doesNotMatch(name, /^(?:pg|postgres|drizzle-orm|drizzle-kit|google-auth-library|dotenv|sharp|@google-cloud\/|@aws-sdk\/|@ffmpeg-installer\/|@vercel\/oidc)/,
      `Backend dependency in the frontend package: ${name}`);
  }
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(command, /drizzle|src\/worker|tsx.*(?:migrate|seed|recover|reconcile)/, `Retired backend command: ${name}`);
  }
});

test('Vercel runs no backend crons', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.deepEqual(config.crons ?? [], []);
});
