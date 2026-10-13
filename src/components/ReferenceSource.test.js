import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceSource } from './PromptComposer.jsx';

const portraits = [{ id: 'p1', byteplusAssetId: 'asset-1', name: 'Sati front', imageUrl: '/api/media/uploads/portrait/u-1' }];

test('portrait gallery references are recognised in every stored form', () => {
  assert.deepEqual(referenceSource('asset://asset-1', 'image', portraits), { type: 'portrait', name: 'Sati front' });
  assert.deepEqual(referenceSource('https://tos.example/x.jpg?sig=1#bp_asset_id=asset-1', 'image', portraits), { type: 'portrait', name: 'Sati front' });
  assert.deepEqual(referenceSource('/api/media/uploads/portrait/u-1', 'image', portraits), { type: 'portrait', name: 'Sati front' });
  assert.equal(referenceSource('https://tos.example/y.jpg#bp_asset_id=asset-gone', 'image', portraits).type, 'portrait');
  assert.equal(referenceSource('/api/media/uploads/portrait/other', 'image', []).type, 'portrait');
});

test('manual uploads and materials are distinguished from portraits', () => {
  assert.deepEqual(referenceSource('/api/media/uploads/image-reference/u-2', 'image', portraits), { type: null, name: null });
  assert.equal(referenceSource('/api/media/assets/a.png', 'material', portraits).type, 'material');
  assert.equal(referenceSource(null, undefined, portraits).type, null);
});
