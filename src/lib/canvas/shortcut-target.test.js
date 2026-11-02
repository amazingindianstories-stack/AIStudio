import assert from 'node:assert/strict';
import test from 'node:test';
import { isEditingTarget } from './shortcut-target.js';

const element = (tagName, { editable = false, inside = [] } = {}) => ({
  tagName, isContentEditable: editable,
  closest: selector => inside.some(name => selector.split(',').map(s => s.trim()).includes(name)) ? {} : null,
});
test('board shortcuts ignore typing targets, dialogs and crop controls', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isEditingTarget(element(tag)), true, tag);
  assert.equal(isEditingTarget(element('DIV', { editable: true })), true);
  assert.equal(isEditingTarget(element('BUTTON', { inside: ['[role="dialog"]'] })), true);
  assert.equal(isEditingTarget(element('BUTTON', { inside: ['[role="alertdialog"]'] })), true);
  assert.equal(isEditingTarget(element('DIV', { inside: ['[data-crop-controls]'] })), true);
  assert.equal(isEditingTarget(element('DIV')), false);
  assert.equal(isEditingTarget(element('BUTTON')), false);
  assert.equal(isEditingTarget(null), false);
});
