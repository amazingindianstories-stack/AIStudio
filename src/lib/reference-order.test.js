import test from 'node:test';
import assert from 'node:assert/strict';
import { referencePermutation } from './reference-order.js';

test('identical media occurrences retain their distinct labels and tags', () => {
  const state = { referenceImages: ['same', 'same', 'other'], referenceIds: ['a','b','c'],
    referenceKinds: ['image','portrait','image'], referenceLabels: ['first','second','third'], referenceTags: ['','@sati',''] };
  const patch = referencePermutation(state, ['b','c','a']);
  assert.deepEqual(patch.referenceIds, ['b','c','a']);
  assert.deepEqual(patch.referenceLabels, ['second','third','first']);
  assert.deepEqual(patch.referenceKinds, ['portrait','image','image']);
  assert.deepEqual(patch.referenceTags, ['@sati','','']);
  assert.equal('prompt' in patch, false, 'a reorder never carries a prompt rewrite');
  assert.throws(() => referencePermutation(state, ['a','a','c']));
});

test('fifty occurrence permutation preserves each payload in deterministic order', () => {
  const state = { referenceImages: Array.from({length:50}, (_,i) => `source-${i}`), referenceIds: Array.from({length:50}, (_,i) => `id-${i}`) };
  const order = [...state.referenceIds.slice(1), state.referenceIds[0]];
  const patch = referencePermutation(state, order);
  assert.equal(patch.referenceImages[49], 'source-0');
  assert.equal(patch.referenceImages[0], 'source-1');
});
