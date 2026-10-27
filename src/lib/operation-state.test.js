import test from 'node:test';
import assert from 'node:assert/strict';
import { installOperationTracking } from './operation-state.js';

test('duplicate clicks coalesce and failed retry preserves idempotency key', async () => {
  let calls = 0; const keys = []; let release;
  const state = { currentUser:{id:'actor'}, operations:{}, loadLibraryTree:async()=>{},
    createFolder:async (...args)=>{ calls++; keys.push(args[3]); await new Promise(resolve => {release=resolve;}); if(calls===1) throw new Error('lost ACK'); return 'folder'; } };
  for (const name of ['renameFolder','setFolderColor','deleteFolder','moveFolder','moveGenerationsToDestination']) state[name]=async()=>{};
  const store={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  installOperationTracking(store);
  const first=state.createFolder('project','folder'); const duplicate=state.createFolder('project','folder');
  assert.equal(first,duplicate); await new Promise(resolve => setImmediate(resolve)); release();
  await assert.rejects(first,/lost ACK/);
  const retry=state.createFolder('project','folder'); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal(await retry,'folder'); assert.equal(calls,2); assert.equal(keys[0],keys[1]);
  assert.equal(Object.values(state.operations)[0].status,'confirmed');
});

test('cancelled queued rename never reaches the server', async () => {
  let calls=0, release;
  const state={currentUser:{id:'actor'},operations:{},loadLibraryTree:async()=>{},
    renameFolder:async()=>{calls++;await new Promise(resolve=>{release=resolve;});}};
  for(const name of ['createFolder','setFolderColor','deleteFolder','moveFolder','moveGenerationsToDestination']) state[name]=async()=>{};
  const store={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  installOperationTracking(store);
  const first=state.renameFolder('folder','first');
  await new Promise(resolve=>setImmediate(resolve));
  const second=state.renameFolder('folder','second');
  const logical=Object.keys(state.operations).find(key=>JSON.parse(key)[2][1]==='second');
  assert.equal(state.cancelFolderOperation(logical),true);
  const rejected=assert.rejects(second,/cancelled/);
  const cancelledAt=state.operations[logical].completedAt;
  release();await Promise.all([first,rejected]);
  assert.equal(calls,1);assert.equal(state.operations[logical].status,'cancelled');
  assert.equal(state.operations[logical].completedAt>=cancelledAt,true,'the settled row keeps a completion time once its queue reaches it');
});
