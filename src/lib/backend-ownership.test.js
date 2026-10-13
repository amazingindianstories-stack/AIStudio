import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkOwnership, checkApiContracts, checkLocalImplementation } from '../../scripts/check-backend-ownership.mjs';

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

test('API inventory cannot drop a retained route or method',()=>{
  fixture('export async function GET() {}',(_root,m)=>{
    assert.ok(checkApiContracts({routes:[]},m).some(e=>e.includes('Missing API contract route')));
    assert.ok(checkApiContracts({routes:[{path:'/api/settings',source:m.routes['/api/settings'].source,methods:[]}]},m).some(e=>e.includes('Missing API contract method')));
  });
});
test('documented method contracts must retain every behavioral dimension',()=>{
  fixture('export async function GET() {}',(_root,m)=>{
    const route={path:'/api/settings',source:m.routes['/api/settings'].source,methods:['GET'],method_contracts:{GET:{success:{status:200}}}};
    assert.ok(checkApiContracts({routes:[route]},m).some(e=>e.includes('Missing API contract dimension db_mutations')));
    assert.ok(checkApiContracts({routes:[route,route]},m).some(e=>e.includes('Duplicate API contract')));
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

test('local retirement cannot restore Node routes or dependencies while preserving historical ownership',()=>{
  fixture('export async function GET() {}',(root,m)=>{
    writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{pg:'1'},scripts:{}}));
    writeFileSync(path.join(root,'vercel.json'),'{}');
    const local={schema_authority_local:'DJANGO_MANAGED',source_retirement:'COMPLETE',methods:[{method:'GET',path:'/api/settings',state:'DJANGO_IMPLEMENTED_LOCAL',evidence:['package.json']}]};
    const errors=checkLocalImplementation(root,local,m);
    assert.ok(errors.some(e=>e.includes('Retired Node backend remains')));
    assert.ok(errors.some(e=>e.includes('Backend dependency remains: pg')));
    assert.equal(m.routes['/api/settings'].methods.GET.owner,'next');
    assert.ok(checkLocalImplementation(root,{...local,methods:[]},m).some(e=>e.includes('Missing local method')));
  });
});
