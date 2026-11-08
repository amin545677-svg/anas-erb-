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
  assert.ok(html.includes('function anasExportCurrentReportXLSX()'));
  assert.ok(html.includes('function anasExportLocalAuditXLSX()'));
  const cellStart = html.indexOf('function anasCsvCell(value)');
  const cellEnd = html.indexOf('function anasExportCurrentReportCSV()', cellStart);
  const cell = html.slice(cellStart, cellEnd);
  assert.ok(cell.includes("s = \"'\" + s"));
  assert.ok(cell.includes("s.replace(/\"/g, '\"\"')"));
});

test('local audit and stocktake CSV declare their semicolon delimiter for Android Excel', async () => {
  const html = await readFile('index.html', 'utf8');
  const auditStart = html.indexOf('function anasExportLocalAudit()');
  const auditEnd = html.indexOf('function anasAiSafeText', auditStart);
  assert.ok(auditStart >= 0 && auditEnd > auditStart, 'local audit exporter must exist');
  assert.ok(html.slice(auditStart, auditEnd).includes("const csv='\\uFEFFsep=;\\r\\n'"),
    'audit CSV must carry UTF-8 BOM and explicit semicolon delimiter');
  const stocktakeStart = html.indexOf('window.anasExportStocktake=function()');
  const stocktakeEnd = html.indexOf('window.anasApproveStocktake=function()', stocktakeStart);
  assert.ok(stocktakeStart >= 0 && stocktakeEnd > stocktakeStart, 'stocktake exporter must exist');
  const stocktake = html.slice(stocktakeStart, stocktakeEnd);
  assert.ok(stocktake.includes("XLSX.writeFile(wb,s.id+'_stocktake.xlsx'"),
    'stocktake must export a real XLSX workbook when the bundled library is available');
  assert.ok(stocktake.includes("const csv='\\uFEFFsep=;\\r\\n'") && stocktake.includes(".join(';')"),
    'CSV fallback must carry UTF-8 BOM and an explicit semicolon delimiter');
});


test('local AI audit XLSX exports both purchase-cost and retail-value inventory totals', async () => {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('function anasExportLocalAuditXLSX()');
  const end = html.indexOf('function anasAiSafeText', start);
  assert.ok(start >= 0 && end > start, 'local audit XLSX exporter must exist');
  const exporter = html.slice(start, end);
  assert.match(exporter, /\['قيمة المخزون بسعر الشراء'\s*,\s*d\.summary\.stockCost\]/);
  assert.match(exporter, /\['قيمة المخزون بسعر البيع'\s*,\s*d\.summary\.stockSell\]/);
  assert.ok(exporter.includes("XLSX.writeFile(wb,'ANAS_ERP_Local_Audit.xlsx'"), 'audit export must be a real XLSX workbook');
});
