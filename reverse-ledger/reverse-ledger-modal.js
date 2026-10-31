(function () {
'use strict';
if (window.ANASReverseLedgerModal) return;

const MODES = Object.freeze({
  SALE_RETURN: { title: 'مرتجع مبيعات', invoiceType: 'sales_invoice', collection: 'invoices' },
  PURCHASE_RETURN: { title: 'مرتجع مشتريات', invoiceType: 'purchase_invoice', collection: 'purchases' },
  INVOICE_CANCEL: { title: 'إلغاء فاتورة', invoiceType: null, collection: null }
});
const byId = id => document.getElementById(id);
const state = { mode: null, invoice: null, invoiceType: null, preview: null, lines: [] };
const MICRO = 1000000n;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function parseMicro(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) throw new Error('الكمية تحتوي على أكثر من ست منازل عشرية أو صيغة غير صحيحة.');
  return BigInt(match[1]) * MICRO + BigInt((match[2] || '').padEnd(6, '0'));
}
function parseCentimes(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new Error('القيمة المالية غير صالحة.');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
function formatMoney(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value || 0);
  return (n / 100n).toString() + '.' + (n % 100n).toString().padStart(2, '0') + ' د.ج';
}
function formatMicro(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value || 0);
  const whole = n / MICRO;
  const fraction = (n % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}
function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
function appData() {
  const current = window.AppData;
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('بيانات التطبيق غير جاهزة.');
  return current;
}
function invoiceRows(mode) {
  const data = appData();
  if (mode === 'SALE_RETURN') return (Array.isArray(data.invoices) ? data.invoices : []).map(row => ({ row, type: 'sales_invoice' }));
  if (mode === 'PURCHASE_RETURN') return (Array.isArray(data.purchases) ? data.purchases : []).map(row => ({ row, type: 'purchase_invoice' }));
  return [
    ...(Array.isArray(data.invoices) ? data.invoices.map(row => ({ row, type: 'sales_invoice' })) : []),
    ...(Array.isArray(data.purchases) ? data.purchases.map(row => ({ row, type: 'purchase_invoice' })) : [])
  ];
}
function invoiceItems(invoice, type) {
  const engine = window.ANASReverseLedger;
  if (!engine || typeof engine.originalInvoiceItems !== 'function') throw new Error('محرك الفواتير العكسية غير محمّل.');
  return engine.originalInvoiceItems(invoice, type);
}
function itemProductId(item) {
  return String(item.productId ?? item.id ?? item.product?.id ?? '');
}
function productById(id) {
  const rows = Array.isArray(appData().products) ? appData().products : [];
  const found = rows.filter(row => row && String(row.id) === String(id));
  return found.length === 1 ? found[0] : null;
}
function priorReturned(invoice, type, productId) {
  const docs = Array.isArray(appData().returns) ? appData().returns : [];
  return docs.filter(doc => doc && doc.ledgerVersion === 2 && doc.status === 'POSTED' &&
    doc.originalInvoiceType === type && String(doc.originalInvoiceId) === String(invoice.id))
    .reduce((sum, doc) => sum + (Array.isArray(doc.items) ? doc.items : [])
      .filter(item => String(item.productId) === String(productId))
      .reduce((part, item) => part + BigInt(item.quantityMicroUnits || 0), 0n), 0n);
}
function warehouseStock(product, invoice, type) {
  const warehouse = String(type === 'sales_invoice'
    ? (invoice.warehouseName || invoice.warehouse || 'المخزن الرئيسي')
    : (invoice.warehouse || 'المخزن الرئيسي')).trim();
  const raw = warehouse === 'المخزن الرئيسي' ? (product.stock ?? 0) : (product.warehouseStock?.[warehouse] ?? 0);
  return parseMicro(raw);
}
function invoiceLabel(row, type) {
  const id = String(row.id ?? '');
  const number = String(row.invoiceNumber ?? row.number ?? row.code ?? id);
  const party = type === 'sales_invoice'
    ? (row.customer?.name ?? row.customerName ?? row.customerObj?.name)
    : (row.supplier?.name ?? row.supplierName);
  let total = 'قيمة غير متاحة';
  try { total = formatMoney(parseCentimes(row.total)); } catch (_) {}
  return number + ' — ' + String(party || 'طرف غير محدد') + ' — ' + total;
}
function status(message, good) {
  const node = byId('rev-eligibility-status');
  if (!node) return;
  node.textContent = message;
  node.style.background = good ? '#ecfdf5' : '#fff7ed';
  node.style.color = good ? '#166534' : '#9a3412';
}
function makeCell(text) {
  const cell = document.createElement('td');
  cell.textContent = String(text ?? '');
  return cell;
}
function renderLines() {
  const body = byId('rev-items-body');
  body.replaceChildren();
  state.lines = [];
  if (!state.invoice) {
    const tr = document.createElement('tr');
    const td = makeCell('اختر فاتورة لعرض الأصناف.');
    td.colSpan = 7;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  let items;
  try { items = invoiceItems(state.invoice, state.invoiceType); }
  catch (error) { status(error.message, false); return; }
  if (!items.length) {
    const tr = document.createElement('tr');
    const td = makeCell('لا توجد أصناف قابلة للتحقق في هذه الفاتورة.');
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  items.forEach((item, index) => {
    let productId, product, originalQuantity, returned, remaining, stock;
    try {
      productId = itemProductId(item);
      product = productById(productId);
      originalQuantity = parseMicro(item.qty ?? item.quantity);
      returned = priorReturned(state.invoice, state.invoiceType, productId);
      remaining = originalQuantity - returned;
      stock = product ? warehouseStock(product, state.invoice, state.invoiceType) : 0n;
    } catch (error) {
      status(error && error.message ? error.message : 'بيانات سطر الفاتورة غير صالحة.', false);
      return;
    }
    const tr = document.createElement('tr');
    tr.appendChild(makeCell(item.name ?? item.productName ?? product?.name ?? productId));
    tr.appendChild(makeCell(formatMicro(originalQuantity)));
    tr.appendChild(makeCell(formatMicro(returned)));
    tr.appendChild(makeCell(formatMicro(remaining)));
    tr.appendChild(makeCell(product ? formatMicro(stock) : 'صنف غير موجود'));
    const td = document.createElement('td');
    if (state.mode === 'INVOICE_CANCEL') {
      td.textContent = 'الكمية كاملة';
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = '0';
      input.dataset.lineIndex = String(index);
      input.setAttribute('aria-label', 'كمية الإرجاع للصنف ' + productId);
      input.style.minWidth = '105px';
      input.addEventListener('input', updatePreview);
      td.appendChild(input);
    }
    tr.appendChild(td);
    const valueCell = makeCell('—');
    valueCell.dataset.lineValue = productId;
    tr.appendChild(valueCell);
    body.appendChild(tr);
    state.lines.push({ item, productId, originalQuantity, returned, remaining, stock });
  });
}
function selectedLines() {
  if (state.mode === 'INVOICE_CANCEL') return undefined;
  const inputs = [...byId('rev-items-body').querySelectorAll('input[data-line-index]')];
  const lines = [];
  inputs.forEach(input => {
    const raw = input.value.trim();
    if (!raw) return;
    const index = Number(input.dataset.lineIndex);
    const line = state.lines[index];
    const quantity = parseMicro(raw);
    if (quantity > 0n) lines.push({ productId: line.productId, quantity: raw });
  });
  if (!lines.length) throw new Error('أدخل كمية مرتجع واحدة على الأقل.');
  return lines;
}
function buildRequest() {
  if (!state.invoice || !state.invoiceType) throw new Error('حدد الفاتورة أولاً.');
  const reason = byId('rev-reason-input').value.trim();
  const request = {
    originalInvoiceType: state.invoiceType,
    returnType: state.mode,
    invoiceId: String(state.invoice.id),
    reason: reason || 'معاينة غير مرحّلة',
    settlementMode: byId('rev-excess-mode').value
  };
  const lines = selectedLines();
  if (lines) request.items = lines;
  return request;
}
function updatePreview() {
  state.preview = null;
  byId('rev-submit-btn').disabled = true;
  byId('rev-preview-total').textContent = '—';
  byId('rev-items-body').querySelectorAll('[data-line-value]').forEach(cell => { cell.textContent = '—'; });
  byId('rev-preview-invoice-remaining').textContent = '—';
  byId('rev-preview-debt-reduction').textContent = '—';
  byId('rev-preview-cash-excess').textContent = '—';
  if (!state.invoice) return;
  try {
    const request = buildRequest();
    const engine = window.ANASReverseLedger;
    if (!engine || typeof engine.previewReturnTransaction !== 'function') {
      throw new Error('نسخة محرك المعاينة المعزولة غير متاحة؛ الترحيل محجوب.');
    }
    const preview = engine.previewReturnTransaction(appData(), request);
    state.preview = preview;
    const previewByProduct = new Map(preview.items.map(item => [String(item.productId), item]));
    byId('rev-items-body').querySelectorAll('[data-line-value]').forEach(cell => {
      const line = previewByProduct.get(String(cell.dataset.lineValue));
      cell.textContent = line ? formatMoney(line.lineTotalCentimes) : '—';
    });
    byId('rev-preview-total').textContent = formatMoney(preview.totalCentimes);
    byId('rev-preview-debt-reduction').textContent = formatMoney(preview.debtReductionCentimes);
    const excess = BigInt(preview.cashRefundCentimes || 0) +
      BigInt(preview.customerCreditCentimes || 0) + BigInt(preview.supplierCreditCentimes || 0);
    byId('rev-preview-cash-excess').textContent = formatMoney(excess);
    const total = parseCentimes(state.invoice.total);
    const paid = parseCentimes(state.invoice.paid ?? 0);
    const partyId = state.invoiceType === 'sales_invoice'
      ? String(state.invoice.customerId ?? state.invoice.customerObj?.id ?? '')
      : String(state.invoice.supplierId ?? state.invoice.supplier?.id ?? '');
    const partyType = state.invoiceType === 'sales_invoice' ? 'customer' : 'supplier';
    const movementType = partyType === 'customer' ? 'customer_debt' : 'supplier_payment';
    const allocations = (Array.isArray(appData().settlementAllocations) ? appData().settlementAllocations : [])
      .filter(row => row && row.partyType === partyType && String(row.partyId) === partyId &&
        row.invoiceType === state.invoiceType && String(row.invoiceId) === String(state.invoice.id) &&
        row.sourceMovementType === movementType)
      .reduce((sum, row) => sum + BigInt(row.amountCentimes), 0n);
    byId('rev-preview-invoice-remaining').textContent = formatMoney(total - paid - allocations);
    const gateway = window.ANASReverseLedgerServer;
    const periodId = byId('rev-period-id').value.trim();
    const reason = byId('rev-reason-input').value.trim();
    byId('rev-submit-btn').disabled = !(gateway && typeof gateway.execute === 'function' && periodId && reason);
    status('المعاينة ناجحة على نسخة بيانات معزولة. لم يتغير أي سجل محلي. الترحيل يتطلب بوابة خادمية موثوقة وصلاحية فترة مالية مفتوحة.', true);
  } catch (error) {
    status(error && error.message ? error.message : 'تعذر حساب المعاينة.', false);
  }
}
function fillInvoices() {
  const select = byId('rev-invoice-select');
  select.replaceChildren(new Option('اختر الفاتورة...', ''));
  const rows = invoiceRows(state.mode);
  rows.forEach((entry, index) => {
    if (!entry.row || entry.row.id == null) return;
    const label = state.mode === 'INVOICE_CANCEL'
      ? (entry.type === 'sales_invoice' ? 'مبيعات — ' : 'مشتريات — ') + invoiceLabel(entry.row, entry.type)
      : invoiceLabel(entry.row, entry.type);
    const option = new Option(label, String(index));
    select.add(option);
  });
  state.availableRows = rows;
  status(rows.length ? 'اختر فاتورة لبدء فحص الأهلية.' : 'لا توجد فواتير متاحة.', false);
}
function onInvoiceChange() {
  const index = Number(byId('rev-invoice-select').value);
  const entry = Number.isInteger(index) && state.availableRows ? state.availableRows[index] : null;
  state.invoice = entry?.row || null;
  state.invoiceType = entry?.type || null;
  state.preview = null;
  renderLines();
  updatePreview();
}
function mount() {
  if (byId('modal-reverse-ledger')) return;
  const style = document.createElement('style');
  style.id = 'anas-reverse-ledger-style';
  style.textContent = '#modal-reverse-ledger{position:fixed;inset:0;z-index:10020;background:rgba(15,23,42,.62);display:none;align-items:center;justify-content:center;padding:12px}'+
    '#modal-reverse-ledger.active{display:flex}#modal-reverse-ledger .rev-dialog{width:min(980px,100%);max-height:94vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.28);direction:rtl;color:#0f172a}'+
    '#modal-reverse-ledger .rev-head{position:sticky;top:0;background:#1e3a6d;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1}'+
    '#modal-reverse-ledger .rev-head h2{font-size:1.05rem;margin:0}#modal-reverse-ledger .rev-close{border:0;background:transparent;color:#fff;font-size:1.5rem;cursor:pointer;padding:2px 8px}'+
    '#modal-reverse-ledger .rev-body{padding:14px;display:grid;gap:12px}#modal-reverse-ledger .rev-section{border:1px solid #dbe3ed;border-radius:10px;padding:12px;display:grid;gap:10px;min-width:0}'+
    '#modal-reverse-ledger .rev-section h3{font-size:.92rem;color:#1e3a6d;margin:0}#modal-reverse-ledger label{font-size:.82rem;font-weight:700;display:grid;gap:6px}'+
    '#modal-reverse-ledger input,#modal-reverse-ledger select{width:100%;min-width:0;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;background:#fff;color:#0f172a}'+
    '#modal-reverse-ledger .rev-status{border-radius:8px;padding:10px;background:#fff7ed;color:#9a3412;font-size:.82rem;font-weight:700}'+
    '#modal-reverse-ledger .rev-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}#modal-reverse-ledger .rev-items{overflow:auto;border:1px solid #e2e8f0;border-radius:8px}'+
    '#modal-reverse-ledger .rev-items table{width:100%;border-collapse:collapse;min-width:650px;font-size:.8rem}#modal-reverse-ledger .rev-items th,#modal-reverse-ledger .rev-items td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:center}#modal-reverse-ledger .rev-items th{background:#f1f5f9}'+
    '#modal-reverse-ledger .rev-preview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#modal-reverse-ledger .rev-preview>div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px}#modal-reverse-ledger .rev-preview small{display:block;color:#64748b;margin-bottom:4px}'+
    '#modal-reverse-ledger .rev-preview strong{font-variant-numeric:tabular-nums}#modal-reverse-ledger .rev-actions{display:flex;gap:8px;justify-content:flex-start;flex-wrap:wrap}#modal-reverse-ledger .rev-actions button{border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:800;cursor:pointer}'+
    '#rev-submit-btn{background:#94a3b8;color:#fff}#rev-submit-btn:enabled{background:#166534}#rev-cancel-btn{background:#e2e8f0;color:#334155}'+
    '@media(max-width:560px){#modal-reverse-ledger{padding:0;align-items:flex-end}#modal-reverse-ledger .rev-dialog{width:100%;max-height:97vh;border-radius:14px 14px 0 0}#modal-reverse-ledger .rev-body{padding:10px}#modal-reverse-ledger .rev-grid,#modal-reverse-ledger .rev-preview{grid-template-columns:1fr}}';
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'modal-reverse-ledger';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'rev-modal-title');
  overlay.innerHTML = '<div class="rev-dialog"><div class="rev-head"><h2 id="rev-modal-title">التسوية العكسية</h2><button type="button" class="rev-close" aria-label="إغلاق" id="rev-close-btn">×</button></div>'+
    '<div class="rev-body"><section class="rev-section"><h3>1. الفاتورة والأهلية</h3><label>الفاتورة<select id="rev-invoice-select"><option value="">اختر الفاتورة...</option></select></label><div id="rev-eligibility-status" class="rev-status" role="status" aria-live="polite">اختر فاتورة لبدء فحص الأهلية.</div></section>'+
    '<section class="rev-section"><h3>2. الأصناف والكميات</h3><div class="rev-items"><table><thead><tr><th>الصنف</th><th>الأصلية</th><th>مرتجع سابقاً</th><th>المتاح للإرجاع</th><th>المخزون الحالي</th><th>الكمية الآن</th><th>قيمة السطر</th></tr></thead><tbody id="rev-items-body"><tr><td colspan="7">اختر فاتورة لعرض الأصناف.</td></tr></tbody></table></div></section>'+
    '<section class="rev-section"><h3>3. المعاينة المالية الدقيقة</h3><div class="rev-preview"><div><small>إجمالي المرتجع</small><strong id="rev-preview-total">—</strong></div><div><small>المتبقي المشتق على الفاتورة</small><strong id="rev-preview-invoice-remaining">—</strong></div><div><small>إطفاء الدين أولاً</small><strong id="rev-preview-debt-reduction">—</strong></div><div><small>الفائض النقدي / الدائن</small><strong id="rev-preview-cash-excess">—</strong></div></div>'+
    '<div class="rev-grid"><label>معالجة الفائض<select id="rev-excess-mode"><option value="cash">نقداً</option><option value="credit">رصيد دائن</option></select></label><label>الفترة المالية (معرّف الخادم)<input id="rev-period-id" maxlength="128" autocomplete="off" placeholder="يتطلب معرّف فترة مفتوحة"></label><label>سبب العملية<input id="rev-reason-input" maxlength="500" placeholder="سبب الإرجاع أو الإلغاء"></label></div></section>'+
    '<div class="rev-actions"><button type="button" id="rev-submit-btn" disabled>طلب الترحيل الخادمي</button><button type="button" id="rev-cancel-btn">إغلاق</button></div><p style="font-size:.75rem;color:#64748b;margin:0">المعاينة تعمل على نسخة منفصلة من البيانات. لا يُسمح بأي تعديل محلي. زر الترحيل لا يعمل إلا عند اتصال بوابة خادمية موثوقة وتحديد فترة مالية مفتوحة.</p></div></div>';
  document.body.appendChild(overlay);
  byId('rev-close-btn').addEventListener('click', close);
  byId('rev-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  byId('rev-invoice-select').addEventListener('change', onInvoiceChange);
  byId('rev-excess-mode').addEventListener('change', updatePreview);
  byId('rev-period-id').addEventListener('input', updatePreview);
  byId('rev-reason-input').addEventListener('input', updatePreview);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay.classList.contains('active')) close(); });
  byId('rev-submit-btn').addEventListener('click', submit);
}
function open(mode) {
  if (!MODES[mode]) throw new Error('Unsupported reverse-ledger mode');
  mount();
  state.mode = mode;
  state.invoice = null;
  state.invoiceType = null;
  state.preview = null;
  byId('rev-modal-title').textContent = MODES[mode].title;
  byId('rev-reason-input').value = '';
  byId('rev-period-id').value = '';
  byId('rev-excess-mode').value = 'cash';
  fillInvoices();
  renderLines();
  updatePreview();
  byId('modal-reverse-ledger').classList.add('active');
  byId('rev-invoice-select').focus();
}
function close() {
  const modal = byId('modal-reverse-ledger');
  if (modal) modal.classList.remove('active');
}
function operationId() {
  const random = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID().replace(/-/g, '')
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return 'REV-' + random;
}
async function submit() {
  const button = byId('rev-submit-btn');
  if (!state.preview || !state.invoice) return;
  const gateway = window.ANASReverseLedgerServer;
  if (!gateway || typeof gateway.execute !== 'function') {
    status('الترحيل محجوب: لم يتم تهيئة بوابة Firebase الخادمية الموثوقة. لم تتغير البيانات.', false);
    button.disabled = true;
    return;
  }
  const periodId = byId('rev-period-id').value.trim();
  const reason = byId('rev-reason-input').value.trim();
  if (!periodId || !reason) {
    status('أدخل الفترة المالية وسبب العملية قبل طلب الترحيل.', false);
    return;
  }
  const request = buildRequest();
  request.reason = reason;
  request.periodId = periodId;
  request.operationId = operationId();
  button.disabled = true;
  button.textContent = 'جارٍ التحقق والترحيل الخادمي…';
  try {
    const response = await gateway.execute(request);
    if (!response || response.ok !== true || !response.document) {
      throw new Error(response && response.error ? String(response.error) : 'لم يؤكد الخادم نجاح الترحيل.');
    }
    status('أكد الخادم نجاح الترحيل. رقم المستند: ' + String(response.document.returnId || '—'), true);
    button.textContent = 'تم تأكيد الترحيل';
    window.alert('تم تأكيد الترحيل الخادمي. رقم المستند: ' + String(response.document.returnId || '—') + '. أعد تحميل بيانات السحابة قبل متابعة العمل.');
    close();
  } catch (error) {
    status('لم يتم الترحيل: ' + String(error && error.message || error) + '. لم يتم اعتماد أي نجاح محلي.', false);
    button.textContent = 'طلب الترحيل الخادمي';
    button.disabled = true;
  }
}
window.ANASReverseLedgerModal = Object.freeze({ open, close, modes: MODES });
window.returnSalePrompt = function () { open('SALE_RETURN'); };
window.returnPurchasePrompt = function () { open('PURCHASE_RETURN'); };
window.cancelInvoicePrompt = function () { open('INVOICE_CANCEL'); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
})();