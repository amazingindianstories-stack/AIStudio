import { readFileSync } from 'node:fs';
if (process.env.MIGRATION_TEST_ISOLATED !== '1') throw new Error('Isolated runner required');
const target=new URL(process.env.DATABASE_URL);
if(target.hostname!=='127.0.0.1'||target.pathname!=='/veevee_django_migration')throw new Error('Disposable database required');
const {rowToItem}=await import('../../src/lib/store-db.js');
const rows=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(rows.map(rowToItem)));
