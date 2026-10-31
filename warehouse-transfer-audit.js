(function (root) {
  'use strict';

  function auditWarehouseTransfers(transfers, movements) {
    if (!Array.isArray(transfers) || !Array.isArray(movements)) {
      throw new TypeError('سجلات التحويلات أو حركات المخزون ليست قوائم صالحة.');
    }

    const issues = [];
    const transferIds = new Set();
    const movementIds = new Set();
    const expectedMovementIds = new Set();
    let checked = 0;

    for (const movement of movements) {
      if (!movement || typeof movement !== 'object' || Array.isArray(movement)) {
        issues.push({ code: 'INVALID_MOVEMENT', message: 'يوجد سجل حركة مخزون غير صالح.' });
        continue;
      }
      if (movement.id != null && String(movement.id).trim()) {
        const id = String(movement.id).trim();
        if (movementIds.has(id)) issues.push({ code: 'DUPLICATE_MOVEMENT_ID', id, message: 'معرّف حركة مخزون مكرر: ' + id });
        movementIds.add(id);
      }
    }

    for (const transfer of transfers) {
      if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer)) {
        issues.push({ code: 'INVALID_TRANSFER', message: 'يوجد سند تحويل غير صالح.' });
        continue;
      }
      const id = transfer.id == null ? '' : String(transfer.id).trim();
      if (!id) {
        issues.push({ code: 'MISSING_TRANSFER_ID', message: 'يوجد سند تحويل بلا معرّف.' });
        continue;
      }
      if (transferIds.has(id)) {
        issues.push({ code: 'DUPLICATE_TRANSFER_ID', id, message: 'معرّف سند تحويل مكرر: ' + id });
        continue;
      }
      transferIds.add(id);
      checked += 1;

      const qty = transfer.quantity;
      const validQty = (typeof qty === 'number' || typeof qty === 'string') &&
        String(qty).trim() !== '' && Number.isFinite(Number(qty)) && Number(qty) > 0;
      if (!validQty) issues.push({ code: 'INVALID_TRANSFER_QUANTITY', id, message: 'كمية غير صالحة في سند التحويل ' + id });
      if (!transfer.from || !transfer.to || String(transfer.from) === String(transfer.to)) {
        issues.push({ code: 'INVALID_TRANSFER_ROUTE', id, message: 'مخزن المصدر والوجهة غير صالحين في السند ' + id });
      }
      if (transfer.productId == null || String(transfer.productId).trim() === '') {
        issues.push({ code: 'MISSING_PRODUCT_ID', id, message: 'السند ' + id + ' لا يحتوي معرّف منتج.' });
      }

      const related = movements.filter(m => m && String(m.referenceType || '') === 'warehouse_transfer' && String(m.referenceId || '') === id);
      const out = related.filter(m => m.type === 'WAREHOUSE_TRANSFER_OUT');
      const incoming = related.filter(m => m.type === 'WAREHOUSE_TRANSFER_IN');
      if (out.length !== 1) issues.push({ code: 'OUT_LEG_COUNT', id, message: 'السند ' + id + ': يجب وجود حركة خروج واحدة فقط.' });
      if (incoming.length !== 1) issues.push({ code: 'IN_LEG_COUNT', id, message: 'السند ' + id + ': يجب وجود حركة دخول واحدة فقط.' });

      const expectedQty = validQty ? Number(qty) : NaN;
      const matches = (m, direction) => {
        if (!m) return false;
        const expectedWarehouse = direction === 'out' ? transfer.from : transfer.to;
        const expectedDelta = direction === 'out' ? -expectedQty : expectedQty;
        return String(m.productId) === String(transfer.productId) &&
          String(m.warehouse || '') === String(expectedWarehouse) &&
          Number.isFinite(Number(m.qty)) && Number(m.qty) === expectedDelta &&
          String(m.fromWarehouse || '') === String(transfer.from) &&
          String(m.toWarehouse || '') === String(transfer.to);
      };
      if (out.length === 1 && !matches(out[0], 'out')) issues.push({ code: 'OUT_LEG_MISMATCH', id, message: 'بيانات حركة الخروج لا تطابق سند التحويل ' + id });
      if (incoming.length === 1 && !matches(incoming[0], 'in')) issues.push({ code: 'IN_LEG_MISMATCH', id, message: 'بيانات حركة الدخول لا تطابق سند التحويل ' + id });

      expectedMovementIds.add(id + '-OUT');
      expectedMovementIds.add(id + '-IN');
    }

    for (const movement of movements) {
      if (!movement || movement.referenceType !== 'warehouse_transfer') continue;
      const id = String(movement.referenceId || '').trim();
      if (!transferIds.has(id)) {
        issues.push({ code: 'ORPHAN_TRANSFER_MOVEMENT', id: movement.id == null ? '' : String(movement.id), message: 'حركة تحويل بلا سند مرجعي: ' + (movement.id || id || 'غير معروف') });
      }
    }

    return { ok: issues.length === 0, checked, issueCount: issues.length, issues };
  }

  root.anasAuditWarehouseTransfers = auditWarehouseTransfers;
  if (typeof module !== 'undefined' && module.exports) module.exports = { auditWarehouseTransfers };
})(typeof window !== 'undefined' ? window : globalThis);
