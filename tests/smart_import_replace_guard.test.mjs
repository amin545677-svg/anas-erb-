import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('smart import exposes explicit merge and ledger-safe replace modes', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /id="smartImportMode"/);
  assert.match(html, /value="merge" selected/);
  assert.match(html, /value="replace"/);
  assert.match(html, /const importMode=box\.querySelector\('#smartImportMode'\)\?\.value==='replace'\?'replace':'merge'/);
  assert.match(html, /const protectedExisting=importMode==='replace'\?existing\.filter\(record=>isReferenced\(record,target\)\):\[\]/);
  assert.match(html, /const next=importMode==='replace'\?protectedExisting\.map\(record=>\(\{\.\.\.record\}\)\):JSON\.parse\(before\)/);
  assert.match(html, /warehouseBalances/);
  assert.match(html, /'debt','balance','creditUsed','initial_debt','credit_limit'/);
  assert.match(html, /ANAS_ERP_PRE_IMPORT_BACKUP_V1/);
  assert.match(html, /await saveDBDurably\(\)/);
  assert.match(html, /فشل الحفظ، أُعيدت بيانات القسم إلى الحالة السابقة/);
  assert.match(html, /احتُفظ تلقائياً بـ '\+retainedProtected/);
});

test('replace mode guards preserve invoice, stock, debt and supplier history references', async () => {
  const html = await readFile('index.html', 'utf8');
  for (const token of [
    'AppData.invoices', 'AppData.purchases', 'AppData.stockMovements',
    'AppData.warehouseTransfers', 'AppData.clientMovements',
    'AppData.settlementAllocations', 'AppData.supplierMovements'
  ]) assert.ok(html.includes(token), 'missing safe-replace reference guard: ' + token);
});
