// Metadata only: import the current schema, never a connection or migration entrypoint.
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../src/lib/schema.js';
const tables = {};
for (const table of Object.values(schema)) {
  const config = getTableConfig(table);
  if (tables[config.name]) throw new Error(`Duplicate table ${config.name}`);
  const primary = config.columns.filter(column => column.primary).map(column => column.name);
  for (const key of config.primaryKeys) primary.push(...key.columns.map(column => column.name));
  tables[config.name] = {
    columns: Object.fromEntries(config.columns.map(column => [column.name, {
      type: column.getSQLType(), nullable: !column.notNull,
    }])),
    primary_key: primary,
    foreign_keys: config.foreignKeys.map(key => {
      const ref = key.reference();
      return { columns: ref.columns.map(column => column.name),
        target_table: getTableConfig(ref.foreignTable).name,
        target_columns: ref.foreignColumns.map(column => column.name),
        on_delete: key.onDelete || 'no action' };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}
process.stdout.write(JSON.stringify(tables));
