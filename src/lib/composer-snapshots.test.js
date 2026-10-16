import test from 'node:test';
import assert from 'node:assert/strict';
import { composerMetadata, persistentMediaRef, snapshotScope } from './composer-snapshots.js';

test('draft metadata excludes binary and signed secrets without shifting occurrence positions', () => {
  const draft = composerMetadata({ prompt:'@img2', referenceImages:['data:image/png;base64,secret', '/api/media/uploads/a/image.png', 'https://store.example/x?token=secret'],
    referenceIds:['a','b','c'], referenceKinds:['image','portrait','image'], referenceVideos:[], referenceAudios:[] });
  assert.deepEqual(draft.refs.map(r => r.mediaRef), [null,'/api/media/uploads/a/image.png',null]);
  assert.equal(draft.refs[1].uiId, 'b');
  assert.equal(JSON.stringify(draft).includes('secret'), false);
  assert.equal(persistentMediaRef('blob:abc'), false);
});

test('draft isolation requires authenticated actor and preserves project scope', () => {
  assert.equal(snapshotScope({currentUser:null}), null);
  assert.notEqual(snapshotScope({currentUser:{id:'A'}, activeProjectId:'P'}), snapshotScope({currentUser:{id:'B'}, activeProjectId:'P'}));
  assert.notEqual(snapshotScope({currentUser:{id:'A'}, activeProjectId:'P'}), snapshotScope({currentUser:{id:'A'}, activeProjectId:'Q'}));
});
