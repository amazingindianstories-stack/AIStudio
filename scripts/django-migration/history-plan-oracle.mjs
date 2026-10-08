import {readFileSync} from 'node:fs';
if(process.env.MIGRATION_TEST_ISOLATED!=='1')throw new Error('Isolated runner required');
const target=new URL(process.env.DATABASE_URL);
if(target.hostname!=='127.0.0.1'||target.pathname!=='/veevee_django_migration')throw new Error('Disposable database required');
const {getDb}=await import('../../src/lib/db.js');
const {queryHistory}=await import('../../src/lib/store-db.js');
const db=await getDb();
function nodes(node){return [{type:node['Node Type'],rows:node['Actual Rows'],removed:node['Rows Removed by Filter']||0,index:node['Index Name']||null},...(node.Plans||[]).flatMap(nodes)];}
const results=[];
for(const entry of JSON.parse(readFileSync(0,'utf8'))){
  const captured=[];
  db.session.logger={logQuery(query,params){captured.push({query,params});}};
  const page=await queryHistory(entry.filter,entry.cursor,20);
  const first=captured[0];
  if(!first.query.trimStart().toUpperCase().startsWith('SELECT'))throw new Error('Read query required');
  const rows=await db.$client.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+first.query,first.params);
  const plan=rows[0]['QUERY PLAN'][0];
  results.push({page,execution_ms:plan['Execution Time'],nodes:nodes(plan.Plan)});
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
