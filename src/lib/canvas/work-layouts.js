/** Pure data layouts. Never query mounted board nodes, which may be culled. */
const DAY = 86400000;
export function treeLayout(records, { collapsed = [], width = 240, rowHeight = 110 } = {}) {
  const byId = new Map(records.map(r => [r.id, r]));
  const children = new Map();
  for (const record of records) {
    const parent = byId.has(record.parentId) ? record.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record);
  }
  const placed = [], seen = new Set();
  let row = 0;
  function visit(record, depth, branch) {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    const item = { ...record, x: depth * width, y: row++ * rowHeight, branch };
    placed.push(item);
    if (!collapsed.includes(record.id)) for (const child of children.get(record.id) || []) visit(child, depth + 1, branch);
  }
  (children.get(null) || []).forEach((r, index) => visit(r, 0, index));
  return placed;
}
export function timelineLayout(records, { startField = 'start', endField = 'end', groupBy = '', dayWidth = 24, rowHeight = 48, headerHeight = 28 } = {}) {
  const parse = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00Z') : NaN;
  const dated = records.filter(r => Number.isFinite(parse(r.cells[startField])));
  const start = dated.length ? Math.min(...dated.map(r => parse(r.cells[startField]))) : Date.UTC(2026, 0, 1);
  const byId = new Map(dated.map(r => [r.id, r]));
  const children = new Map();
  for (const record of dated) {
    const parent = byId.has(record.parentId) ? record.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record);
  }
  const group = record => groupBy ? String(record.cells[groupBy] ?? '') || 'Unassigned' : '';
  const roots = children.get(null) || [];
  const groups = [], placed = [], seen = new Set();
  let y = 0;
  function visit(r, depth) {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const a = parse(r.cells[startField]);
    const b = parse(r.cells[endField]);
    placed.push({ ...r, depth, x: (a - start) / DAY * dayWidth, y,
      w: Math.max(dayWidth, (Math.max(a, Number.isFinite(b) ? b : a) - a) / DAY * dayWidth + dayWidth), milestone: a === b });
    y += rowHeight;
    for (const child of children.get(r.id) || []) visit(child, depth + 1);
  }
  for (const label of [...new Set(roots.map(group))]) {
    if (groupBy) { groups.push({ label, y }); y += headerHeight; }
    for (const root of roots.filter(r => group(r) === label)) visit(root, 0);
  }
  return { start, groups, height: y, records: placed };
}
export function storyLayout(records, { activityField = 'activity', taskField = 'task', releaseField = 'release' } = {}) {
  const value = (record, key) => String(record.cells[key] ?? '') || 'Unassigned';
  const releases = [...new Set(records.map(r => value(r, releaseField)))];
  const activities = [];
  for (const record of records) {
    const name = value(record, activityField), taskName = value(record, taskField);
    let activity = activities.find(a => a.name === name);
    if (!activity) activities.push(activity = { name, tasks: [] });
    let task = activity.tasks.find(t => t.name === taskName);
    if (!task) activity.tasks.push(task = { name: taskName, stories: new Map(releases.map(release => [release, []])) });
    task.stories.get(value(record, releaseField)).push(record);
  }
  return { activities, releases };
}
export function numberPresentation(value, field) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return { text: '', color: undefined };
  // Plain numbers keep at most two decimals so formula results such as 100 / 3 fit their cell.
  let text = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(number);
  if (field.format === 'currency') text = new Intl.NumberFormat('en', { style: 'currency', currency: field.currency || 'USD' }).format(number);
  if (field.format === 'percent') text = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 }).format(number);
  const color = [...(field.colors || [])].sort((a, b) => a.min - b.min).filter(r => number >= r.min).at(-1)?.color;
  return { text, color, progress: field.format === 'progress' ? Math.max(0, Math.min(100, number)) : null };
}
const NUMBER_TYPES = ['number', 'points', 'formula'];
/** A cell as display text: numbers formatted, people by name (a short id until names load), anything else as text. */
export function cellText(value, field, people = new Map()) {
  if (NUMBER_TYPES.includes(field?.type)) return numberPresentation(value, field).text;
  if (field?.type === 'people' && value) {
    const person = people.get(value);
    return person?.name || person?.email || String(value).slice(0, 8);
  }
  return String(value ?? '');
}
const LABEL_CHAR = 6, LABEL_MAX = 24;
/**
 * Bar chart category labels for bars `slot` px apart: level and whole when every name fits its bar, otherwise
 * upright (so none spills past the chart edge) and capped at 24 characters. `space` is the height they need below the axis.
 */
export function chartAxisLabels(names, slot) {
  const level = names.every(name => name.length * LABEL_CHAR <= slot - 4);
  const text = names.map(name => level || name.length <= LABEL_MAX ? name : name.slice(0, LABEL_MAX - 1) + '…');
  const longest = Math.max(0, ...text.map(t => t.length));
  return { rotated: !level, text, space: level ? 30 : longest * LABEL_CHAR + 24 };
}
export function csvParse(source) {
  if (source.length > 5_000_000) throw new Error('Import files must be under 5 MB.');
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (ch === ',' || ch === '\n' || ch === '\r')) {
      row.push(cell); cell = '';
      if (ch !== ',') { rows.push(row); row = []; if (ch === '\r' && source[i + 1] === '\n') i++; }
    } else cell += ch;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field.');
  if (cell || row.length) rows.push([...row, cell]);
  if (rows.length > 10001) throw new Error('Import at most 10000 records.');
  return rows;
}
export function csvStringify(rows) {
  return rows.map(row => row.map(value => {
    const raw = String(value ?? '');
    // Keep exported text from being treated as spreadsheet formulas.
    return '"' + (/^[=+@\-\t\r]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
export function downloadWork(filename, data, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
