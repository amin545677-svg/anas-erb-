'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditWarehouseTransfers } = require('../warehouse-transfer-audit.js');

function fixture() {
  const transfer = { id: 'TR-1', productId: 'P-1', quantity: 4, from: 'المخزن الرئيسي', to: 'مخزن 1' };
  const movements = [
    { id: 'TR-1-OUT', productId: 'P-1', qty: -4, type: 'WAREHOUSE_TRANSFER_OUT', referenceType: 'warehouse_transfer', referenceId: 'TR-1', warehouse: 'المخزن الرئيسي', fromWarehouse: 'المخزن الرئيسي', toWarehouse: 'مخزن 1' },
    { id: 'TR-1-IN', productId: 'P-1', qty: 4, type: 'WAREHOUSE_TRANSFER_IN', referenceType: 'warehouse_transfer', referenceId: 'TR-1', warehouse: 'مخزن 1', fromWarehouse: 'المخزن الرئيسي', toWarehouse: 'مخزن 1' }
  ];
  return { transfers: [transfer], movements };
}

test('accepts a matching transfer with exactly one out and one in leg', () => {
  const f = fixture();
  assert.deepEqual(auditWarehouseTransfers(f.transfers, f.movements), { ok: true, checked: 1, issueCount: 0, issues: [] });
});

test('reports a missing incoming leg', () => {
  const f = fixture();
  const r = auditWarehouseTransfers(f.transfers, [f.movements[0]]);
  assert.ok(r.issues.some(x => x.code === 'IN_LEG_COUNT'));
});

test('reports mismatched quantity and warehouse', () => {
  const f = fixture();
  f.movements[1].qty = 5;
  f.movements[1].warehouse = 'مخزن آخر';
  const r = auditWarehouseTransfers(f.transfers, f.movements);
  assert.ok(r.issues.some(x => x.code === 'IN_LEG_MISMATCH'));
});

test('reports orphan transfer movements', () => {
  const f = fixture();
  f.movements.push({ id: 'ORPHAN', type: 'WAREHOUSE_TRANSFER_IN', referenceType: 'warehouse_transfer', referenceId: 'UNKNOWN' });
  assert.ok(auditWarehouseTransfers(f.transfers, f.movements).issues.some(x => x.code === 'ORPHAN_TRANSFER_MOVEMENT'));
});

test('reports duplicate transfer and movement identities', () => {
  const f = fixture();
  f.transfers.push({ ...f.transfers[0] });
  f.movements.push({ ...f.movements[0] });
  const r = auditWarehouseTransfers(f.transfers, f.movements);
  assert.ok(r.issues.some(x => x.code === 'DUPLICATE_TRANSFER_ID'));
  assert.ok(r.issues.some(x => x.code === 'DUPLICATE_MOVEMENT_ID'));
});

test('rejects invalid quantities and identical warehouses', () => {
  const f = fixture();
  f.transfers[0].quantity = -1;
  f.transfers[0].to = f.transfers[0].from;
  const r = auditWarehouseTransfers(f.transfers, f.movements);
  assert.ok(r.issues.some(x => x.code === 'INVALID_TRANSFER_QUANTITY'));
  assert.ok(r.issues.some(x => x.code === 'INVALID_TRANSFER_ROUTE'));
});


test('reports extra movements attached to a transfer reference', () => {
  const f = fixture();
  f.movements.push({ id: 'TR-1-EXTRA', productId: 'P-1', qty: 0, type: 'UNKNOWN_TRANSFER_LEG', referenceType: 'warehouse_transfer', referenceId: 'TR-1' });
  assert.ok(auditWarehouseTransfers(f.transfers, f.movements).issues.some(x => x.code === 'UNEXPECTED_TRANSFER_LEG_COUNT'));
});

test('rejects malformed collections instead of silently coercing them', () => {
  assert.throws(() => auditWarehouseTransfers({}, []), TypeError);
  assert.throws(() => auditWarehouseTransfers([], null), TypeError);
});
