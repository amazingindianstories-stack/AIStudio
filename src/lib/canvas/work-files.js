import { csvParse, csvStringify, downloadWork } from './work-layouts';

export async function readWorkFile(file) {
  if (file.size > 5_000_000) throw new Error('Import files must be under 5 MB.');
  if (!file.name.toLowerCase().endsWith('.xlsx')) return csvParse(await file.text());
  const { readSheet } = await import('read-excel-file/universal');
  const rows = await readSheet(file);
  if (rows.length > 10001 || rows.some(row => row.length > 64)) throw new Error('Import at most 10000 rows and 64 columns.');
  return rows.map(row => row.map(value => value instanceof Date ? value.toISOString().slice(0, 10) : value ?? ''));
}
export async function exportWorkFile(fields, records, excel = false) {
  const rows = [fields.map(f => f.id), ...records.map(r => fields.map(f => Array.isArray(r.cells[f.id]) ? r.cells[f.id].join(';') : r.cells[f.id] ?? ''))];
  if (!excel) return downloadWork('records.csv', csvStringify(rows));
  const { default: writeXlsxFile } = await import('write-excel-file/universal');
  downloadWork('records.xlsx', await writeXlsxFile(rows, { sheet: 'Records' }).toBlob(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
