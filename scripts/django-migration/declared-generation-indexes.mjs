// Qualification fixture metadata only; no connection or production migration.
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {generations} from '../../src/lib/schema.js';
const dialect=new PgDialect();
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const indexes=getTableConfig(generations).indexes.map(({config})=>{
  const columns=config.columns.map(column=>{
    if(!column.name || !column.indexConfig)throw new Error('Unsupported declared index expression');
    const {order,nulls,opClass}=column.indexConfig;
    if(opClass)throw new Error('Explicit opclass needs qualification support');
    return quote(column.name)+(order?' '+order:'')+(nulls?' NULLS '+nulls:'');
  });
  const where=config.where?dialect.sqlToQuery(config.where):null;
  if(where?.params.length)throw new Error('Parameterized index predicate unsupported');
  return {name:config.name,sql:'CREATE '+(config.unique?'UNIQUE ':'')+'INDEX IF NOT EXISTS '+quote(config.name)+
    ' ON "generations" USING '+(config.method||'btree')+' ('+columns.join(',')+')'+(where?' WHERE '+where.sql:'')};
});
process.stdout.write(JSON.stringify(indexes));
