(function () {
'use strict';
if (window.ANASSettlementAllocationModal) return;
const byId = id => document.getElementById(id);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const state = { partyType: 'customer', partyId: '', source: null, invoice: null, sources: [], invoices: [] };
function data() {
  // The production shell keeps AppData as a top-level lexical binding to preserve V42.
  // The isolated staging console assigns window.AppData after authentication and snapshot load.
  const current = window.AppData || (typeof AppData !== 'undefined' ? AppData : null);
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('بيانات التطبيق غير جاهزة.');
  return current;
}
function cents(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new Error('المبلغ يجب أن يكون موجباً أو صفراً وبمنزلتين عشريتين كحد أقصى.');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
function money(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value || 0);
  return (n / 100n).toString() + '.' + (n % 100n).toString().padStart(2, '0') + ' د.ج';
}
function rowId(row) { return row && (row.id ?? row.movementId); }
function movementAmount(row) {
  if (Number.isSafeInteger(row.amountCentimes) && row.amountCentimes >= 0) return BigInt(row.amountCentimes);
  return cents(row.amount ?? row.amt);
}
function partyIdForInvoice(invoice, type) {
  return String(type === 'customer'
    ? (invoice.customerId ?? invoice.customerObj?.id ?? '')
    : (invoice.supplierId ?? invoice.supplier?.id ?? ''));
}
function invoicesForParty() {
  const db = data();
  const type = state.partyType;
  const rows = type === 'customer' ? db.invoices : db.purchases;
  if (!Array.isArray(rows)) throw new Error('سجل الفواتير غير صالح.');
  return rows.filter(row => row && partyIdForInvoice(row, type) === state.partyId);
}
function allocations() {
  const rows = data().settlementAllocations;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error('دفتر تخصيص الدفعات تالف؛ أُوقف التخصيص لحماية البيانات.');
  return rows;
}
function allocatedToSource(source) {
  return allocations().filter(row => row && row.partyType === state.partyType &&
    row.sourceMovementType === source.sourceMovementType &&
    String(row.sourceMovementId) === String(source.sourceMovementId) &&
    String(row.partyId) === state.partyId)
    .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
}
function invoiceAllocations(invoice) {
  const invoiceType = state.partyType === 'customer' ? 'sales_invoice' : 'purchase_invoice';
  return allocations().filter(row => row && row.partyType === state.partyType &&
    row.invoiceType === invoiceType && String(row.invoiceId) === String(invoice.id) &&
    String(row.partyId) === state.partyId);
}
function invoicePaid(invoice) {
  if (Number.isSafeInteger(invoice.paidCentimes) && invoice.paidCentimes >= 0) return BigInt(invoice.paidCentimes);
  return cents(invoice.paid ?? 0);
}
function allocatedToInvoice(invoice) {
  const laterType = state.partyType === 'customer' ? 'customer_debt' : 'supplier_payment';
  const laterAllocated = invoiceAllocations(invoice).filter(row => row.sourceMovementType === laterType)
    .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
  return invoicePaid(invoice) + laterAllocated;
}
function sourceInvoiceRemaining(invoice) {
  const initialType = state.partyType === 'customer' ? 'sales_invoice' : 'purchase_invoice';
  if (state.source && state.source.sourceMovementType === initialType) {
    const initialAllocated = invoiceAllocations(invoice).filter(row => row.sourceMovementType === initialType)
      .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
    return invoicePaid(invoice) - initialAllocated;
  }
  return invoiceTotal(invoice) - allocatedToInvoice(invoice);
}
function collectSources() {
  const db = data();
  const found = [];
  if (state.partyType === 'customer') {
    if (db.cashMovements !== undefined && !Array.isArray(db.cashMovements)) throw new Error('دفتر حركات الصندوق غير صالح.');
    for (const row of (Array.isArray(db.cashMovements) ? db.cashMovements : [])) {
      if (!row || !['sales_invoice', 'customer_debt'].includes(row.referenceType)) continue;
      const id = rowId(row);
      if (id == null || String(id).trim() === '') continue;
      let partyId = '';
      let linkedInvoiceId = null;
      if (row.referenceType === 'customer_debt') partyId = String(row.referenceId ?? '');
      else {
        linkedInvoiceId = String(row.referenceId ?? '');
        const matches = (db.invoices || []).filter(invoice => invoice && String(invoice.id) === linkedInvoiceId);
        if (matches.length !== 1) continue;
        partyId = partyIdForInvoice(matches[0], 'customer');
      }
      if (partyId !== state.partyId) continue;
      const source = {
        row, sourceMovementId: String(id), sourceMovementType: row.referenceType,
        amountCentimes: movementAmount(row), linkedInvoiceId
      };
      const assigned = allocatedToSource(source);
      if (assigned < source.amountCentimes) found.push({ ...source, assignedCentimes: assigned });
    }
  } else {
    if (!Array.isArray(db.supplierMovements)) throw new Error('دفتر حركات الموردين غير صالح.');
    for (const row of db.supplierMovements) {
      if (!row || row.type !== 'payment' ||
          !['purchase_invoice', 'supplier_payment'].includes(row.referenceType) ||
          String(row.supplierId ?? '') !== state.partyId) continue;
      const id = rowId(row);
      if (id == null || String(id).trim() === '') continue;
      if (row.referenceType === 'supplier_payment' && String(row.referenceId ?? '') !== String(id)) continue;
      const source = {
        row, sourceMovementId: String(id), sourceMovementType: row.referenceType,
        amountCentimes: movementAmount(row),
        linkedInvoiceId: row.referenceType === 'purchase_invoice' ? String(row.referenceId ?? '') : null
      };
      const assigned = allocatedToSource(source);
      if (assigned < source.amountCentimes) found.push({ ...source, assignedCentimes: assigned });
    }
  }
  return found;
}
function invoiceTotal(invoice) {
  if (Number.isSafeInteger(invoice.totalCentimes) && invoice.totalCentimes >= 0) return BigInt(invoice.totalCentimes);
  return cents(invoice.total);
}
function sourceLabel(source) {
  const name = source.sourceMovementType === 'customer_debt' ? 'قبض دين عميل' :
    source.sourceMovementType === 'supplier_payment' ? 'دفعة مورد' :
    source.sourceMovementType === 'sales_invoice' ? 'دفعة فاتورة مبيعات' : 'دفعة فاتورة مشتريات';
  return name + ' — ' + source.sourceMovementId + ' — ' + money(source.amountCentimes);
}
function invoiceLabel(invoice) {
  const number = invoice.invoiceNumber ?? invoice.number ?? invoice.code ?? invoice.id;
  const total = invoiceTotal(invoice);
  const assigned = allocatedToInvoice(invoice);
  return String(number) + ' — إجمالي ' + money(total) + ' — المتبقي ' + money(total - assigned);
}
function status(message, good) {
  const node = byId('alloc-status');
  node.textContent = message;
  node.style.background = good ? '#ecfdf5' : '#fff7ed';
  node.style.color = good ? '#166534' : '#9a3412';
}
function renderParties() {
  const db = data();
  const rows = state.partyType === 'customer' ? db.customers : db.suppliers;
  if (!Array.isArray(rows)) throw new Error('سجل الأطراف غير صالح.');
  const select = byId('alloc-party');
  select.replaceChildren(new Option('اختر الطرف...', ''));
  rows.filter(row => row && row.id != null).forEach(row => {
    select.add(new Option(String(row.name ?? row.companyName ?? row.id), String(row.id)));
  });
  select.value = state.partyId;
}
function renderSources() {
  const select = byId('alloc-source');
  select.replaceChildren(new Option('اختر حركة قبض أو دفع...', ''));
  state.sources = collectSources();
  state.sources.forEach((source, index) => select.add(new Option(sourceLabel(source), String(index))));
  state.source = null;
  byId('alloc-assigned-total').textContent = '—';
  byId('alloc-source-remaining').textContent = '—';
  byId('alloc-invoice').replaceChildren(new Option('اختر الفاتورة...', ''));
  state.invoices = [];
  state.invoice = null;
  renderMatch();
}
function renderInvoices() {
  const select = byId('alloc-invoice');
  select.replaceChildren(new Option('اختر الفاتورة...', ''));
  const rows = invoicesForParty();
  state.invoices = rows.filter(invoice => {
    if (state.source?.linkedInvoiceId && String(invoice.id) !== state.source.linkedInvoiceId) return false;
    try { return sourceInvoiceRemaining(invoice) > 0n; } catch (_) { return false; }
  });
  state.invoices.forEach((invoice, index) => select.add(new Option(invoiceLabel(invoice), String(index))));
  state.invoice = null;
  if (state.source?.linkedInvoiceId && state.invoices.length === 1) {
    select.value = '0';
    state.invoice = state.invoices[0];
  }
  renderInvoiceBalance();
  renderMatch();
}
function renderInvoiceBalance() {
  const node = byId('alloc-invoice-remaining');
  if (!state.invoice) { node.textContent = '—'; return; }
  const remaining = sourceInvoiceRemaining(state.invoice);
  node.textContent = money(remaining);
}
function renderMatch() {
  const source = state.source;
  const fill = byId('alloc-match-fill');
  if (!source) {
    fill.style.width = '0%';
    byId('alloc-match-label').textContent = 'اختر حركة لعرض المطابقة.';
    return;
  }
  const assigned = source.assignedCentimes;
  const total = source.amountCentimes;
  const percent = total > 0n ? Number((assigned * 10000n) / total) / 100 : 0;
  fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  byId('alloc-assigned-total').textContent = money(assigned) + ' / ' + money(total);
  byId('alloc-source-remaining').textContent = money(total - assigned);
  byId('alloc-match-label').textContent = percent >= 100
    ? 'اكتمل تخصيص حركة القبض أو الدفع.'
    : 'المخصص ' + percent.toFixed(2) + '% من قيمة الحركة.';
}
function refresh() {
  state.partyId = byId('alloc-party').value;
  state.source = null;
  state.invoice = null;
  byId('alloc-amount').value = '';
  if (!state.partyId) {
    state.sources = [];
    byId('alloc-source').replaceChildren(new Option('اختر الطرف أولاً...', ''));
    byId('alloc-invoice').replaceChildren(new Option('اختر حركة أولاً...', ''));
    renderMatch();
    return;
  }
  try {
    renderSources();
    status('اختر حركة قبض أو دفع، ثم اربطها بفاتورة من الطرف نفسه.', true);
  } catch (error) { status(error.message || String(error), false); }
}
function selectSource() {
  const index = Number(byId('alloc-source').value);
  state.source = Number.isInteger(index) ? state.sources[index] || null : null;
  byId('alloc-amount').value = '';
  if (!state.source) { renderInvoices(); return; }
  renderInvoices();
  renderMatch();
  if (state.source.linkedInvoiceId && state.invoices.length !== 1) {
    status('الفاتورة المرتبطة بحركة الدفع مفقودة أو ملتبسة؛ لا يمكن تخصيص هذه الحركة.', false);
  } else status('تم تحديد مصدر الدفعة. اختر الفاتورة وأدخل المبلغ بدقة.', true);
}
function validateDraft() {
  if (!state.source || !state.invoice) throw new Error('حدد حركة الدفع والفاتورة أولاً.');
  const amount = cents(byId('alloc-amount').value);
  if (amount <= 0n) throw new Error('مبلغ التخصيص يجب أن يكون أكبر من صفر.');
  const sourceRemaining = state.source.amountCentimes - state.source.assignedCentimes;
  const invoiceRemaining = sourceInvoiceRemaining(state.invoice);
  if (amount !== sourceRemaining) throw new Error('يجب أن يساوي مجموع التخصيصات كامل الرصيد المتبقي لحركة القبض أو الدفع؛ فرق السنتيم يجب أن يكون صفراً.');
  if (amount > invoiceRemaining) throw new Error('مبلغ التخصيص يتجاوز الرصيد المشتق للفاتورة.');
  return amount;
}
function updateDraft() {
  const button = byId('alloc-submit');
  try {
    const amount = validateDraft();
    const remaining = state.source.amountCentimes - state.source.assignedCentimes - amount;
    const assignedAfter = state.source.assignedCentimes + amount;
    const percent = state.source.amountCentimes > 0n
      ? Number((assignedAfter * 10000n) / state.source.amountCentimes) / 100 : 0;
    byId('alloc-assigned-total').textContent = money(assignedAfter) + ' / ' + money(state.source.amountCentimes);
    byId('alloc-match-fill').style.width = Math.max(0, Math.min(100, percent)) + '%';
    byId('alloc-match-label').textContent = 'المطابقة بعد الحفظ: ' + percent.toFixed(2) + '%';
    byId('alloc-draft-match').textContent = 'سيبقى غير مخصص: ' + money(remaining);
    button.disabled = false;
    status('المطابقة صحيحة: المبلغ لا يتجاوز رصيد الحركة ولا رصيد الفاتورة.', true);
  } catch (error) {
    renderMatch();
    byId('alloc-draft-match').textContent = '—';
    button.disabled = true;
    status(error.message || String(error), false);
  }
}
function makeId() {
  const random = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID().replace(/-/g, '')
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return 'ALLOC-' + random;
}
async function submit() {
  let amount;
  try { amount = validateDraft(); }
  catch (error) { status(error.message || String(error), false); return; }
  const gateway = window.ANASSettlementAllocationServer;
  if (!gateway || typeof gateway.execute !== 'function') {
    status('بوابة تخصيص الدفعات السحابية غير متاحة؛ لم تتغير أي بيانات.', false);
    return;
  }
  const periodId = String(byId('alloc-period-id')?.value || '').trim();
  if (!periodId) { status('أدخل معرّف الفترة المالية المفتوحة قبل الترحيل.', false); return; }
  const button = byId('alloc-submit');
  button.disabled = true;
  button.textContent = 'جارٍ التحقق والترحيل الخادمي…';
  const request = {
    operationId: makeId(), periodId, partyType: state.partyType, partyId: state.partyId,
    sourceMovementId: state.source.sourceMovementId, sourceMovementType: state.source.sourceMovementType,
    allocations: [{ invoiceId: String(state.invoice.id), amountCentimes: Number(amount) }]
  };
  try {
    const result = await gateway.execute(request);
    if (!result || result.ok !== true || result.status !== 'POSTED' || result.operationId !== request.operationId ||
        !Array.isArray(result.allocations) || result.allocations.length !== 1) throw new Error('لم يؤكد الخادم ترحيل تخصيص الدفعة.');
    if (typeof window.ANASReloadStagingSnapshot !== 'function') throw new Error('تم الترحيل الخادمي لكن دالة تحديث النسخة غير متاحة؛ أعد قراءة النسخة السحابية قبل أي عملية مالية أخرى.');
    await window.ANASReloadStagingSnapshot();
    window.alert('تم ترحيل تخصيص الدفعة سحابياً والتحقق منه. لم يُعدّل رصيد الفاتورة محلياً.');
    refresh();
    button.textContent = 'اعتماد التخصيص';
  } catch (error) {
    status(error && error.message ? error.message : 'فشل التخصيص الخادمي؛ لم يُعتمد أي تغيير محلي.', false);
    button.textContent = 'إعادة المحاولة';
  } finally { button.disabled = false; }
}
function close() {
  const modal = byId('modal-settlement-allocation');
  if (modal) modal.classList.remove('active');
}
function mount() {
  if (byId('modal-settlement-allocation')) return;
  const style = document.createElement('style');
  style.id = 'anas-settlement-allocation-style';
  style.textContent = '#modal-settlement-allocation{position:fixed;inset:0;z-index:10019;background:rgba(15,23,42,.62);display:none;align-items:center;justify-content:center;padding:12px}'+
    '#modal-settlement-allocation.active{display:flex}#modal-settlement-allocation .alloc-dialog{width:min(760px,100%);max-height:92vh;overflow:auto;background:#fff;color:#0f172a;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.28);direction:rtl}'+
    '#modal-settlement-allocation .alloc-head{background:#1e3a6d;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center}#modal-settlement-allocation h2{font-size:1rem;margin:0}'+
    '#modal-settlement-allocation .alloc-body{padding:14px;display:grid;gap:12px}#modal-settlement-allocation .alloc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}'+
    '#modal-settlement-allocation label{display:grid;gap:6px;font-size:.82rem;font-weight:700}#modal-settlement-allocation input,#modal-settlement-allocation select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff;color:#0f172a}'+
    '#modal-settlement-allocation .alloc-card{border:1px solid #dbe3ed;border-radius:10px;padding:12px;display:grid;gap:8px}#modal-settlement-allocation .alloc-status{padding:10px;border-radius:8px;background:#fff7ed;color:#9a3412;font-size:.82rem;font-weight:700}'+
    '#modal-settlement-allocation .alloc-track{height:12px;border-radius:20px;background:#e2e8f0;overflow:hidden}#modal-settlement-allocation .alloc-fill{height:100%;width:0;background:#16a34a;transition:width .15s}'+
    '#modal-settlement-allocation .alloc-actions{display:flex;gap:8px;flex-wrap:wrap}#modal-settlement-allocation button{border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:800;cursor:pointer}#alloc-submit{background:#166534;color:#fff}#alloc-submit:disabled{background:#94a3b8;cursor:not-allowed}#alloc-close{background:#e2e8f0;color:#334155}'+
    '@media(max-width:560px){#modal-settlement-allocation{padding:0;align-items:flex-end}#modal-settlement-allocation .alloc-dialog{width:100%;max-height:97vh;border-radius:14px 14px 0 0}#modal-settlement-allocation .alloc-grid{grid-template-columns:1fr}}';
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'modal-settlement-allocation';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'alloc-title');
  overlay.innerHTML = '<div class="alloc-dialog"><div class="alloc-head"><h2 id="alloc-title">تخصيص الدفعات على الفواتير</h2><button type="button" id="alloc-close" aria-label="إغلاق">×</button></div>'+
    '<div class="alloc-body"><div class="alloc-grid"><label>نوع الطرف<select id="alloc-party-type"><option value="customer">عميل</option><option value="supplier">مورد</option></select></label><label>العميل / المورد<select id="alloc-party"><option value="">اختر الطرف...</option></select></label></div>'+
    '<label>حركة القبض أو الدفع<select id="alloc-source"><option value="">اختر حركة...</option></select></label><label>الفاتورة المستحقة<select id="alloc-invoice"><option value="">اختر الفاتورة...</option></select></label><label>الفترة المالية المفتوحة (معرّف الخادم)<input id="alloc-period-id" maxlength="128" autocomplete="off" placeholder="مثال: FY-2026-10"></label>'+
    '<div class="alloc-card"><strong>مطابقة مصدر الدفعة</strong><div id="alloc-assigned-total">—</div><div class="alloc-track"><div id="alloc-match-fill" class="alloc-fill"></div></div><div id="alloc-match-label">اختر حركة لعرض المطابقة.</div><small>الرصيد غير المخصص للمصدر: <strong id="alloc-source-remaining">—</strong></small><small>الرصيد المشتق للفاتورة: <strong id="alloc-invoice-remaining">—</strong></small></div>'+
    '<div class="alloc-grid"><label>مبلغ التخصيص (د.ج)<input id="alloc-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></label><div class="alloc-card"><strong>المطابقة بعد التخصيص</strong><span id="alloc-draft-match">—</span></div></div>'+
    '<div id="alloc-status" class="alloc-status" role="status" aria-live="polite">اختر الطرف ومصدر الدفعة للبدء.</div><div class="alloc-actions"><button type="button" id="alloc-submit" disabled>حفظ التخصيص</button><button type="button" id="alloc-close-bottom">إغلاق</button></div>'+
    '<p style="font-size:.75rem;color:#64748b;margin:0">لا يتم تعديل قيمة الفاتورة أو paid أو remaining. يُحفظ التخصيص كسجل مستقل بدقة السنتيم، ويُعاد دفتر التخصيصات إلى حالته السابقة عند فشل الحفظ.</p></div></div>';
  document.body.appendChild(overlay);
  byId('alloc-party-type').addEventListener('change', () => {
    state.partyType = byId('alloc-party-type').value;
    state.partyId = '';
    renderParties();
    refresh();
  });
  byId('alloc-party').addEventListener('change', refresh);
  byId('alloc-source').addEventListener('change', selectSource);
  byId('alloc-invoice').addEventListener('change', () => {
    const index = Number(byId('alloc-invoice').value);
    state.invoice = Number.isInteger(index) ? state.invoices[index] || null : null;
    renderInvoiceBalance();
    updateDraft();
  });
  byId('alloc-amount').addEventListener('input', updateDraft);
  byId('alloc-submit').addEventListener('click', submit);
  byId('alloc-close').addEventListener('click', close);
  byId('alloc-close-bottom').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay.classList.contains('active')) close(); });
  // Do not read account data while mounting: the staging console is unauthenticated
  // until its operator signs in and explicitly loads the cloud snapshot.
}
function open() {
  mount();
  state.partyType = 'customer';
  state.partyId = '';
  state.source = null;
  state.invoice = null;
  byId('alloc-party-type').value = state.partyType;
  byId('alloc-amount').value = '';
  if (byId('alloc-period-id')) byId('alloc-period-id').value = '';
  byId('alloc-draft-match').textContent = '—';
  byId('modal-settlement-allocation').classList.add('active');
  try {
    renderParties();
    refresh();
  } catch (error) {
    setStatus(error && error.message ? error.message : 'بيانات التطبيق غير جاهزة.', false);
    const submitButton = byId('alloc-submit');
    if (submitButton) submitButton.disabled = true;
  }
}
window.ANASSettlementAllocationModal = Object.freeze({ open, close });
window.openSettlementAllocationModal = open;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
})();