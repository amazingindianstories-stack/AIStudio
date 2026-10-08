import { sql } from 'drizzle-orm';
if(process.env.MIGRATION_TEST_ISOLATED!=='1')throw new Error('Isolated runner required');
const target=new URL(process.env.DATABASE_URL);
if(target.hostname!=='127.0.0.1'||target.pathname!=='/veevee_django_migration')throw new Error('Disposable database required');
const {getDb}=await import('../../src/lib/db.js');
const db=await getDb();
const results=[];
for(const value of [1,1.5,2,1e20,1e-7,9007199254740992,1e21,1e22,1e30,Number.MAX_VALUE,Number.MIN_VALUE,1e-6,0.0000011,1e-8,9223372036854775807,9223372036854774784,999999999999999900000]){
  try{
    const rows=await db.execute(sql`SELECT 2::bigint > ${value} AS matched, ${value}::bigint::text AS operand`);
    results.push({value,matched:rows[0].matched,operand:rows[0].operand});
  }catch(error){results.push({value,error_code:error.code||error.cause?.code});}
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
