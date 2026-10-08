// Metadata and source text only. Do not import migration entrypoints/dotenv.
import {readFileSync} from 'node:fs';
import {getTableConfig, PgDialect} from 'drizzle-orm/pg-core';
import * as schema from '../../src/lib/schema.js';
const dialect = new PgDialect();
const checks = [];
for (const table of Object.values(schema)) {
  const config = getTableConfig(table);
  for (const check of config.checks) {
    const query = dialect.sqlToQuery(check.value);
    if (query.params.length) throw new Error('Parameterized check needs explicit qualification');
    checks.push({table: config.name, name: check.name, sql: query.sql.replaceAll(`"${config.name}".`, '')});
  }
}
const source = readFileSync(new URL('../migrate-folder-color.js', import.meta.url), 'utf8');
const matches = [...source.matchAll(/ALTER TABLE folders ADD CONSTRAINT (folders_color_check)\s+CHECK \(([^;]+)\);/g)];
if (matches.length !== 1) throw new Error('Folder color check source format changed; review required');
checks.push({table: 'folders', name: matches[0][1], sql: matches[0][2]});
process.stdout.write(JSON.stringify(checks));
