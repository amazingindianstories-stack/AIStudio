// Schema metadata only. No connection, dotenv or migration entrypoints.
import {SQL} from 'drizzle-orm';
import {getTableConfig, PgDialect} from 'drizzle-orm/pg-core';
import * as schema from '../../src/lib/schema.js';
const dialect = new PgDialect();
const tables = {};
for (const table of Object.values(schema)) {
  const config = getTableConfig(table);
  tables[config.name] = Object.fromEntries(config.columns.map(column => {
    if (column.defaultFn || column.onUpdateFn) throw new Error('Runtime default requires separate qualification');
    let value = {kind: 'none'};
    if (column.default instanceof SQL) {
      const query = dialect.sqlToQuery(column.default);
      if (query.params.length || query.sql !== 'gen_random_uuid()') throw new Error('SQL default needs explicit support');
      value = {kind: 'sql', value: query.sql};
    } else if (column.default !== undefined) {
      value = {kind: 'literal', value: column.default};
    } else if (column.hasDefault) {
      throw new Error('Unrepresented default');
    }
    return [column.name, {type: column.getSQLType(), ...value}];
  }));
}
process.stdout.write(JSON.stringify(tables));
