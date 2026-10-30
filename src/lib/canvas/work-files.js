import { csvParse, csvStringify, downloadWork } from './work-layouts';

export async function readWorkFile(file) {
  if (file.size > 5_000_000) throw new Error('Import files must be under 5 MB.');
  if (!file.name.toLowerCase().endsWith('.xlsx')) return csvParse(await file.text());
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  if (sheet.rowCount > 10001 || sheet.columnCount > 64) throw new Error('Import at most 10000 rows and 64 columns.');
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const values = [];
    for (let i = 1; i <= sheet.columnCount; i++) {
      const value = row.getCell(i).value;
      values.push(value instanceof Date ? value.toISOString().slice(0, 10) : value && typeof value === 'object' ? (value.text ?? value.result ?? value.richText?.map(v => v.text).join('') ?? '') : value ?? '');
    }
    rows.push(values);
  });
  return rows;
}
export async function exportWorkFile(fields, records, excel = false) {
  const rows = [fields.map(f => f.id), ...records.map(r => fields.map(f => Array.isArray(r.cells[f.id]) ? r.cells[f.id].join(';') : r.cells[f.id] ?? ''))];
  if (!excel) return downloadWork('records.csv', csvStringify(rows));
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Records');
  rows.forEach(row => sheet.addRow(row));
  downloadWork('records.xlsx', await workbook.xlsx.writeBuffer(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
