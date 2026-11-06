import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('report CSV declares semicolon delimiter for Excel regional settings and quotes Arabic fields safely', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function anasExportCurrentReportCSV()');
  const end = html.indexOf('function anasPrintCurrentReport()', start);
  assert.ok(start >= 0 && end > start, 'report CSV exporter must exist');
  const exporter = html.slice(start, end);
  assert.ok(exporter.includes("let csv = '\\uFEFFsep=;\\r\\n'"));
  assert.ok(exporter.includes(".join(';')"));
  assert.ok(exporter.includes(".join('\\r\\n')"));
  assert.ok(html.includes('function anasCsvCell(value)'));
  const cellStart = html.indexOf('function anasCsvCell(value)');
  const cellEnd = html.indexOf('function anasExportCurrentReportCSV()', cellStart);
  const cell = html.slice(cellStart, cellEnd);
  assert.ok(cell.includes("s = \"'\" + s"));
  assert.ok(cell.includes("s.replace(/\"/g, '\"\"')"));
});
