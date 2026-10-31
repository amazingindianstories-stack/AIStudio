import assert from 'node:assert/strict';
import test from 'node:test';
import { treeLayout, timelineLayout, storyLayout, csvParse, csvStringify, numberPresentation } from './work-layouts.js';
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
test('timeline groups roots by the view field and nests children under their parent', () => {
  const rows = [
    { id: 'child', parentId: 'design', cells: { title: 'Wireframes', start: '2026-10-03', end: '2026-10-04', team: 'Product' } },
    { id: 'build', parentId: null, cells: { title: 'Build', start: '2026-10-05', end: '2026-10-09', team: 'Engineering' } },
    { id: 'design', parentId: null, cells: { title: 'Design', start: '2026-10-01', end: '2026-10-04', team: 'Product' } },
    { id: 'leaf', parentId: 'child', cells: { title: 'Review', start: '2026-10-04', end: '2026-10-04', team: 'Engineering' } },
    { id: 'loose', parentId: null, cells: { title: 'Loose', start: '2026-10-02' } },
  ];
  const layout = timelineLayout(rows, { groupBy: 'team' });
  assert.deepEqual(layout.groups, [{ label: 'Engineering', y: 0 }, { label: 'Product', y: 76 }, { label: 'Unassigned', y: 248 }]);
  assert.deepEqual(layout.records.map(r => [r.id, r.depth, r.y]), [['build', 0, 28], ['design', 0, 104], ['child', 1, 152], ['leaf', 2, 200], ['loose', 0, 276]]);
  assert.equal(layout.height, 324);
  assert.equal(layout.records.find(r => r.id === 'child').x, 48);
  const flat = timelineLayout(rows);
  assert.deepEqual(flat.groups, []);
  assert.deepEqual(flat.records.map(r => r.id), ['build', 'design', 'child', 'leaf', 'loose']);
  assert.equal(flat.height, 240);
});
test('story map places each story under its activity, task and release', () => {
  const map = storyLayout([
    { id: '1', cells: { phase: 'Discover', task: 'Search', release: 'MVP' } },
    { id: '2', cells: { phase: 'Discover', task: 'Filter', release: 'Later' } },
    { id: '3', cells: { phase: 'Buy', task: 'Pay', release: 'MVP' } },
    { id: '4', cells: { phase: 'Discover', task: 'Search', release: 'Later' } },
    { id: '5', cells: { phase: 'Discover' } },
  ], { activityField: 'phase' });
  assert.deepEqual(map.releases, ['MVP', 'Later', 'Unassigned']);
  assert.deepEqual(map.activities.map(a => [a.name, a.tasks.map(t => t.name)]), [['Discover', ['Search', 'Filter', 'Unassigned']], ['Buy', ['Pay']]]);
  const search = map.activities[0].tasks[0].stories;
  assert.deepEqual([...search].map(([release, stories]) => [release, stories.map(s => s.id)]), [['MVP', ['1']], ['Later', ['4']], ['Unassigned', []]]);
  assert.deepEqual(map.activities[0].tasks[2].stories.get('Unassigned').map(s => s.id), ['5']);
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
