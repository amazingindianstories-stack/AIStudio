// Read current schema metadata only; never import a database connection.
import {getTableConfig, PgDialect} from 'drizzle-orm/pg-core';
import * as schema from '../../src/lib/schema.js';
const dialect = new PgDialect();
const tables = {};
for (const table of Object.values(schema)) {
  const config = getTableConfig(table);
  tables[config.name] = config.indexes.map(({config: index}) => {
    if ((index.method || 'btree') !== 'btree') throw new Error('Index method needs explicit support');
    const predicate = index.where ? dialect.sqlToQuery(index.where) : null;
    if (predicate?.params.length) throw new Error('Parameterized index predicate unsupported');
    return {name: index.name, unique: Boolean(index.unique), columns: index.columns.map(column => {
      if (!column.name || !column.indexConfig || column.indexConfig.opClass) throw new Error('Index expression/opclass needs explicit support');
      const order = column.indexConfig.order || 'asc';
      return {name: column.name, order, nulls: column.indexConfig.nulls || (order === 'desc' ? 'first' : 'last')};
    }), predicate: predicate?.sql || null};
  });
}
process.stdout.write(JSON.stringify(tables));
