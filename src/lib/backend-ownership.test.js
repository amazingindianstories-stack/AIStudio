import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkOwnership } from '../../scripts/check-backend-ownership.mjs';

function fixture(source, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ownership-test-'));
  try {
    mkdirSync(path.join(root,'src/app/api/settings'), {recursive:true});
    writeFileSync(path.join(root,'src/app/api/settings/route.js'),source);
    const manifest = {schema_authority:'DRIZZLE',auth_authority:'NEXT',workers:{generation:'NODE'},exceptions:[],routes:{'/api/settings':{source:'src/app/api/settings/route.js',baseline_sha256:createHash('sha256').update(source).digest('hex'),methods:{GET:{owner:'next',next_status:'active',state:'IMPLEMENTING',evidence:[]}}}}};
    run(root,manifest);
  } finally { rmSync(root,{recursive:true,force:true}); }
}

test('ownership guard recognizes exported arrow handlers and rejects unregistered methods',()=>{
  fixture('export const GET = async () => {}; export const POST = async () => {};',(root,m)=>{
    assert.ok(checkOwnership(root,m).some(e=>e.includes('Unregistered Node method: POST')));
  });
});
test('ownership guard recognizes aliased handlers',()=>{
  fixture('const handler = () => {}; export { handler as GET };',(root,m)=>{
    assert.deepEqual(checkOwnership(root,m),[]);
  });
});
test('retired implementation cannot be restored even by resetting its baseline',()=>{
  fixture('export async function GET() {}',(root,m)=>{
    m.routes['/api/settings'].methods.GET={owner:'django',next_status:'removed',state:'NODE_REMOVED',evidence:[]};
    const errors=checkOwnership(root,m);
    assert.ok(errors.some(e=>e.includes('Retired implementation restored')));
    assert.ok(errors.some(e=>e.includes('Missing cutover evidence')));
  });
});
