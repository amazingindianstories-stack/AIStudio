import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrateFolderColor } from '../../scripts/migrate-folder-color.js';

test('folder colour upgrades populated old schema, defaults NULL, preserves rows and repeats safely', async () => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  assert.ok(['/veevee_ci', '/veevee_django_migration', '/veevee_codex_regression'].includes(target.pathname));
  const root = postgres(target.href, { max: 1 });
  const namespace = `color_upgrade_${randomUUID().replaceAll('-', '')}`;
  await root.unsafe(`CREATE SCHEMA ${namespace}`);
  const client = postgres(target.href, { max: 1, connection: { search_path: namespace } });
  const db = drizzle(client);
  try {
    await client.unsafe('CREATE TABLE folders (id uuid PRIMARY KEY, name text NOT NULL, project_id uuid, version integer NOT NULL, updated_at bigint NOT NULL)');
    const id = randomUUID();
    await client`INSERT INTO folders VALUES (${id}, 'दृश्य', NULL, 7, 123456789)`;
    const before = await client`SELECT * FROM folders`;
    await migrateFolderColor(db);
    await migrateFolderColor(db);
    const after = await client`SELECT * FROM folders`;
    assert.equal(after[0].color, null);
    const { color, ...preserved } = after[0];
    assert.equal(color, null);
    assert.deepEqual(preserved, before[0]);
    for (const token of ['gray','red','orange','yellow','green','blue','purple','pink',null]) {
      await client`UPDATE folders SET color = ${token} WHERE id = ${id}`;
      assert.equal((await client`SELECT color FROM folders`)[0].color, token);
    }
    for (const token of ['default', 'RED', '', 'magenta']) {
      await assert.rejects(client`UPDATE folders SET color = ${token}`, error => error.code === '23514');
    }
    const checks = await client`SELECT conname FROM pg_constraint WHERE conrelid = 'folders'::regclass AND conname = 'folders_color_check' AND convalidated`;
    assert.equal(checks.length, 1);
  } finally {
    await client.end();
    await root.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
    await root.end();
  }
});
