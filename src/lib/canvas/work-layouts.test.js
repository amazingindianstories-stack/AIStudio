import assert from 'node:assert/strict';
import test from 'node:test';
import { treeLayout, timelineLayout, csvParse, csvStringify, numberPresentation } from './work-layouts.js';
import { treeToBoard, buildTimeline } from './work-generators.js';
import { validateCanvasState } from './serialization.js';
import { readWorkFile } from './work-files.js';

const records = [
  { id: 'a', parentId: null, cells: { title: 'Root', start: '2026-10-01', end: '2026-10-03' } },
  { id: 'b', parentId: 'a', cells: { title: 'Child', start: '2026-10-02', end: '2026-10-02' } },
  { id: 'c', parentId: 'b', cells: { title: 'Leaf' } },
];
test('tree layout collapses branches without changing records; shape export keeps links', () => {
  assert.equal(treeLayout(records)[2].x, 480);
  assert.equal(treeLayout(records, { collapsed: ['a'] }).length, 1);
  const board = treeToBoard({ nodes: [], connectors: [] }, records, {}, { x: 10000, y: 12000 });
  assert.equal(board.nodes.length, 3);
  assert.equal(board.connectors.length, 2);
  assert.equal(board.nodes[2].x, 10480);
  assert.deepEqual(validateCanvasState(board).nodes, board.nodes);
  assert.equal(validateCanvasState(board).connectors.length, 2);
});
test('timeline dates, milestones and invalid intervals are deterministic', () => {
  const layout = timelineLayout(records);
  assert.equal(layout.records.length, 2);
  assert.equal(layout.records[0].w, 72);
  assert.equal(layout.records[1].x, 24);
  assert.equal(layout.records[1].milestone, true);
  const generated = buildTimeline({ nodes: [], connectors: [] }, { start: '2026-01-31', end: '2026-04-01', interval: 'month', lanes: 'Design\nBuild', color: '#dbeafe' }, { x: 0, y: 0 });
  assert.equal(generated.nodes.length, 12);
  assert.equal(validateCanvasState(generated).nodes.length, 12);
  assert.throws(() => buildTimeline({ nodes: [] }, { start: '2026-01-01', end: '2026-12-31', interval: 'day', lanes: 'Team' }, { x: 0, y: 0 }), /120/);
});
test('CSV preserves quotes and multiline values and prevents exported formulas', () => {
  assert.deepEqual(csvParse('title,notes\r\n"A, B","two\nlines with ""quotes"""\r\n'), [['title', 'notes'], ['A, B', 'two\nlines with "quotes"']]);
  assert.equal(csvStringify([['=1+1', 'x"y']]), '"\'=1+1","x""y"');
  assert.throws(() => csvParse('"unclosed'), /Unclosed/);
});
test('number fields format currency, percent, progress and conditional colors', () => {
  assert.equal(numberPresentation(0.25, { format: 'percent' }).text, '25%');
  assert.equal(numberPresentation(12, { format: 'currency' }).text, '$12.00');
  assert.equal(numberPresentation(150, { format: 'progress', colors: [{ min: 10, color: '#ff0000' }] }).progress, 100);
  assert.equal(numberPresentation(150, { colors: [{ min: 10, color: '#ff0000' }] }).color, '#ff0000');
});
test('Excel import reads native workbook values without executing formulas', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Records');
  sheet.addRow(['title', 'points', 'start']);
  sheet.addRow(['Example', 5, new Date('2026-10-30T00:00:00Z')]);
  sheet.addRow([{ formula: '1+1', result: 2 }, 0, '']);
  const file = new File([await workbook.xlsx.writeBuffer()], 'records.xlsx');
  const rows = await readWorkFile(file);
  assert.deepEqual(rows[1], ['Example', 5, '2026-10-30']);
  assert.equal(rows[2][0], 2);
});
