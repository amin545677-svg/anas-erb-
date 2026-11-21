(function (root) {
  'use strict';

  function auditWarehouseTransfers(transfers, movements) {
    if (!Array.isArray(transfers) || !Array.isArray(movements)) {
      throw new TypeError('سجلات التحويلات أو حركات المخزون ليست قوائم صالحة.');
    }

    const issues = [];
    const transferIds = new Set();
    const movementIds = new Set();
    const movementsByReference = new Map();
    let checked = 0;

    // Build one index in O(M); avoid rescanning the complete ledger for every transfer.
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
      if (movement.referenceType === 'warehouse_transfer') {
        const referenceId = String(movement.referenceId || '').trim();
        if (!movementsByReference.has(referenceId)) movementsByReference.set(referenceId, []);
        movementsByReference.get(referenceId).push(movement);
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

      const related = movementsByReference.get(id) || [];
      const out = related.filter(m => m.type === 'WAREHOUSE_TRANSFER_OUT');
      const incoming = related.filter(m => m.type === 'WAREHOUSE_TRANSFER_IN');
      if (related.length !== 2) issues.push({ code: 'UNEXPECTED_TRANSFER_LEG_COUNT', id, message: 'السند ' + id + ': يجب أن يرتبط بحركتي مخزون فقط.' });
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
    }

    for (const [referenceId, related] of movementsByReference) {
      if (!transferIds.has(referenceId)) {
        for (const movement of related) {
          issues.push({ code: 'ORPHAN_TRANSFER_MOVEMENT', id: movement.id == null ? '' : String(movement.id), message: 'حركة تحويل بلا سند مرجعي: ' + (movement.id || referenceId || 'غير معروف') });
        }
      }
    }

    return { ok: issues.length === 0, checked, issueCount: issues.length, issues };
  }

  root.anasAuditWarehouseTransfers = auditWarehouseTransfers;
  if (typeof module !== 'undefined' && module.exports) module.exports = { auditWarehouseTransfers };
})(typeof window !== 'undefined' ? window : globalThis);


/* Load isolated P0/P1 fleet and thermal engines only in the browser runtime. */
if (typeof window !== 'undefined') {
  import('./fleet/truck-settlement-engine.mjs').then(function(m){window.ANASTruckFleetEngine=m;window.dispatchEvent(new CustomEvent('anas:fleet-engine-ready'));}).catch(function(e){console.error('[ANAS] fleet engine failed to load',e);});
  import('./printing/arabic-escpos-engine.js').then(function(){
    function installThermalPrinterPanel(){
      if(!document||!window.ANASArabicEscPos||document.getElementById('anasThermalPrinterPanel'))return;
      var view=document.getElementById('view-settings');if(!view)return;
      var engine=window.ANASArabicEscPos,panel=document.createElement('section');
      panel.id='anasThermalPrinterPanel';panel.style.cssText='margin:12px;padding:16px;border:1px solid var(--border-color,#d7dce3);border-radius:16px;background:var(--card-bg,#fff);color:var(--text-color,inherit);';
      panel.innerHTML='<h3 style="margin:0 0 8px">الطباعة الحرارية العربية</h3><p style="margin:0 0 12px;font-size:13px;opacity:.78">اختيار مقاس الورق ومسار الاتصال، مع حفظ الطباعة المتعثرة محلياً لإعادة المحاولة.</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px"><label>مقاس الورق<select id="anasThermalPaper" style="display:block;width:100%;padding:9px;border-radius:9px"><option value="58mm">58mm — 384px</option><option value="80mm">80mm — 576px</option></select></label><label>مسار الطباعة<select id="anasThermalTransport" style="display:block;width:100%;padding:9px;border-radius:9px"><option value="auto">تلقائي (Bluetooth / Android)</option><option value="bluetooth">Bluetooth</option><option value="android">Android WebView</option><option value="rawbt">RawBT</option></select></label></div><label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="anasThermalRawbtFallback"> السماح بالتحويل إلى RawBT عند تعذر المسارات الأخرى</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" id="anasThermalSave" style="padding:10px 14px;border:0;border-radius:9px">حفظ الإعدادات</button><button type="button" id="anasThermalTest" style="padding:10px 14px;border:0;border-radius:9px">طباعة وصل اختبار</button><button type="button" id="anasThermalRetry" style="padding:10px 14px;border:0;border-radius:9px">إعادة محاولة الطباعة</button><button type="button" id="anasThermalShare" style="padding:10px 14px;border:0;border-radius:9px">مشاركة صورة الاختبار</button></div><p id="anasThermalStatus" role="status" aria-live="polite" style="margin:12px 0 0;font-size:13px">جاهز للإعداد</p>';
      view.appendChild(panel);
      var paper=panel.querySelector('#anasThermalPaper'),transport=panel.querySelector('#anasThermalTransport'),fallback=panel.querySelector('#anasThermalRawbtFallback'),status=panel.querySelector('#anasThermalStatus');
      var saved=engine.getSettings();paper.value=saved.paper||'58mm';transport.value=saved.transport||'auto';fallback.checked=saved.allowRawBTFallback!==false;
      function settings(){return{...engine.getSettings(),paper:paper.value,transport:transport.value,allowRawBTFallback:fallback.checked};}
      function save(){engine.saveSettings(settings());status.textContent='تم حفظ إعدادات الطابعة على هذا الجهاز.';return settings();}
      function testDocument(){return engine.buildInvoiceReceipt({businessName:'ANAS ERP',invoiceNumber:'THERMAL-TEST',date:new Date().toLocaleString('ar-DZ'),customerName:'اختبار الطابعة',oldDebtMinor:0n,invoiceTotalMinor:0n,paidMinor:0n,footer:'اختبار وضوح العربية والأرقام'});}
      panel.querySelector('#anasThermalSave').addEventListener('click',function(){try{save();}catch(e){status.textContent='تعذر الحفظ: '+String(e.message||e);}});
      panel.querySelector('#anasThermalTest').addEventListener('click',async function(){try{var s=save();status.textContent='جارٍ تجهيز الإيصال والاتصال بالطابعة…';var result=await engine.printDocument(testDocument(),{printer:s,idempotencyKey:'THERMAL-TEST-'+Date.now()});status.textContent=result.status==='QUEUED_FOR_RETRY'?'حُفظ الإيصال في طابور الطباعة. أعد المحاولة بعد فحص الطابعة.':'تم إرسال إيصال الاختبار للطابعة.';}catch(e){status.textContent='تعذرت الطباعة: '+String(e.message||e);}});
      panel.querySelector('#anasThermalRetry').addEventListener('click',async function(){try{var s=save(),storage=window.ANASResilientStorage;if(!storage)throw Error('التخزين المحلي غير جاهز');var q=engine.createPrintQueue({storage:storage,send:function(bytes,meta){return engine.sendPreferred(bytes,{...s,...meta});}}),items=await q.list(),pending=items.filter(x=>x.status==='PENDING');if(!pending.length){status.textContent='لا توجد مهام طباعة معلقة.';return;}var count=0;for(var item of pending){await q.retry(item.id);count++;}status.textContent='نجحت إعادة طباعة '+count+' مهمة.';}catch(e){status.textContent='بقيت مهمة الطباعة محفوظة: '+String(e.message||e);}});
      panel.querySelector('#anasThermalShare').addEventListener('click',async function(){try{var s=save(),canvas=engine.renderReceiptCanvas(testDocument(),{paper:s.paper});await engine.shareImage(canvas);status.textContent='تم فتح مشاركة صورة الإيصال.';}catch(e){status.textContent='تعذرت مشاركة الصورة: '+String(e.message||e);}});
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installThermalPrinterPanel,{once:true});else installThermalPrinterPanel();
  }).catch(function(e){console.error('[ANAS] Arabic ESC/POS engine failed to load',e);});
}
