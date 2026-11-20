(function (root) {
  'use strict';

  function anasCustomerDebtForSave(isEditing, existingCustomer, requestedDebt) {
    if (!isEditing) return requestedDebt;
    return existingCustomer && Object.prototype.hasOwnProperty.call(existingCustomer, 'debt')
      ? existingCustomer.debt : 0;
  }

  function anasCustomerDebtFilterMatches(customer, filter) {
    const raw = customer && Object.prototype.hasOwnProperty.call(customer, 'debt') ? customer.debt : 0;
    const debt = raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === '') ? 0 : Number(raw);
    if (!Number.isFinite(debt) || debt < 0) return filter === 'all';
    if (filter === 'debt') return debt > 0;
    if (filter === 'clear') return debt === 0;
    return filter === 'all';
  }

  function anasGetCustomerDebtCollections(customerId, movements) {
    if (!Array.isArray(movements) || customerId === undefined || customerId === null || String(customerId).trim() === '') return [];
    return movements.filter(m => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
      const amount = Number(m.amount);
      return m.referenceType === 'customer_debt' &&
        String(m.referenceId ?? '') === String(customerId) &&
        m.type === 'add' && Number.isFinite(amount) && amount > 0;
    }).slice().sort((a, b) => {
      const dateA = Date.parse(a.date), dateB = Date.parse(b.date);
      return (Number.isFinite(dateB) ? dateB : 0) - (Number.isFinite(dateA) ? dateA : 0);
    }).slice(0, 10);
  }

  function escapeCustomerDebtHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function anasRenderCustomerDebtCollections(customer, movements) {
    const rows = anasGetCustomerDebtCollections(customer && customer.id, movements);
    const safe = value => typeof root.escapeQuickText === 'function'
      ? root.escapeQuickText(String(value ?? '')) : escapeCustomerDebtHtml(value);
    const money = value => Number(value).toLocaleString('fr-DZ', { maximumFractionDigits: 2 }) + ' د.ج';
    const content = rows.length ? rows.map(m => {
      const parsedDate = Date.parse(m.date);
      const date = Number.isFinite(parsedDate) ? new Date(parsedDate).toLocaleString('fr-DZ') : 'تاريخ غير محدد';
      return '<div style="display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--border-color,#e2e8f0)">' +
        '<div style="min-width:0"><strong>' + safe(date) + '</strong><div style="font-size:11px;color:var(--text-muted,#64748b)">' +
        safe(m.userName || 'مستخدم غير محدد') + '</div></div><strong style="white-space:nowrap;color:#16a34a">' +
        money(Number(m.amount)) + '</strong></div>';
    }).join('') : '<p style="font-size:12px;color:var(--text-muted,#64748b)">لا توجد حركات تحصيل مسجلة لهذا العميل في سجل الصندوق.</p>';
    return '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:var(--text-muted,#64748b)">' +
      'سجل تحصيل الديون المسجل (' + rows.length + ' آخر حركات)</summary><div style="margin-top:7px">' + content + '</div></details>';
  }

  function setCustomerDirectoryDebtFilter(filter) {
    if (!['all', 'debt', 'clear'].includes(filter)) return;
    root.anasCustomerDirectoryDebtFilter = filter;
    if (root.document) root.document.querySelectorAll('[data-customer-debt-filter]').forEach(button => {
      const active = button.getAttribute('data-customer-debt-filter') === filter;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.style.fontWeight = active ? '700' : '400';
      button.style.borderColor = active ? 'var(--primary-color,#1e3a6d)' : '';
    });
    if (typeof root.renderCustomerDirectory === 'function') root.renderCustomerDirectory();
  }

  const api = Object.freeze({
    anasCustomerDebtForSave,
    anasCustomerDebtFilterMatches,
    anasGetCustomerDebtCollections,
    anasRenderCustomerDebtCollections,
    setCustomerDirectoryDebtFilter
  });
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
