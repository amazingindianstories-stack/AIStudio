import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}

test('frontend runtime import graph contains no Node database, provider or auth implementation', () => {
  const roots = [...files('src/components'), ...files('src/app').filter(name => !name.startsWith('src/app/api/')), 'src/middleware.js']
    .filter(name => /\.(js|jsx)$/.test(name));
  const visited = new Set();
  function visit(file) {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(process.cwd(), file);
    assert.doesNotMatch(relative, /src\/lib\/(?:providers\/|agents\/|.*-db\.js$|db\.js$|auth\.js$|schema\.js$|storage\.js$|save-media\.js$|pricing\.js$)/);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /process\.env\.(?:AUTH_SECRET|DATABASE_URL|[A-Z_]*(?:API_KEY|PRIVATE_KEY|CLIENT_SECRET|REFRESH_TOKEN))/);
    for (const [, dependency] of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)/g)) {
      assert.doesNotMatch(dependency, /^(?:pg|postgres|drizzle-orm|@google-cloud\/|@aws-sdk\/|google-auth-library|sharp)(?:\/|$)/);
      const target = dependency.startsWith('@/') ? path.resolve('src', dependency.slice(2)) : dependency.startsWith('.') ? path.resolve(path.dirname(file), dependency) : null;
      if (!target) continue;
      const resolved = [target, `${target}.js`, `${target}.jsx`, path.join(target, 'index.js')].find(name => existsSync(name) && statSync(name).isFile());
      assert.ok(resolved, `Unresolved frontend dependency ${dependency} from ${relative}`);
      visit(resolved);
    }
  }
  roots.forEach(visit);
  assert.ok(visited.size > 70);
});
