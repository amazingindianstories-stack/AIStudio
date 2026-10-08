import {getTableConfig} from 'drizzle-orm/pg-core';
import * as schema from '../../src/lib/schema.js';
const result = [];
for (const table of Object.values(schema)) {
  const config = getTableConfig(table);
  for (const key of config.foreignKeys) {
    const ref = key.reference();
    result.push({table: config.name, name: key.getName(), columns: ref.columns.map(c => c.name), target_table: getTableConfig(ref.foreignTable).name, target_columns: ref.foreignColumns.map(c => c.name), on_delete: key.onDelete || 'no action'});
  }
}
process.stdout.write(JSON.stringify(result));
