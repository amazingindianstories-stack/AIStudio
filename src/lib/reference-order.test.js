import test from 'node:test';
import assert from 'node:assert/strict';
import { referencePermutation } from './reference-order.js';
import { renumberImgMentions } from './mentions.js';

test('identical media occurrences retain their distinct labels and mention bindings', () => {
  const state = { referenceImages: ['same', 'same', 'other'], referenceIds: ['a','b','c'],
    referenceKinds: ['image','portrait','image'], referenceLabels: ['first','second','third'], referenceTags: ['','@sati',''] };
  const { patch, mapping } = referencePermutation(state, ['b','c','a']);
  assert.deepEqual(patch.referenceLabels, ['second','third','first']);
  assert.deepEqual(patch.referenceKinds, ['portrait','image','image']);
  assert.equal(renumberImgMentions('@img1 @IMG2 @img10 @img1suffix @img02 @sati', mapping), '@img3 @IMG1 @img10 @img1suffix @img02 @sati');
  assert.throws(() => referencePermutation(state, ['a','a','c']));
});

test('fifty occurrence permutation preserves each payload in deterministic order', () => {
  const state = { referenceImages: Array.from({length:50}, (_,i) => `source-${i}`), referenceIds: Array.from({length:50}, (_,i) => `id-${i}`) };
  const order = [...state.referenceIds.slice(1), state.referenceIds[0]];
  const { patch, mapping } = referencePermutation(state, order);
  assert.equal(patch.referenceImages[49], 'source-0');
  assert.equal(renumberImgMentions('@img1 @img10 @vid1 @audio1', mapping), '@img50 @img9 @vid1 @audio1');
});
