(function () {
 'use strict';
 if (window.__ANAS_DURABILITY_STATUS_V1__) return;
 window.__ANAS_DURABILITY_STATUS_V1__ = true;
 function appData() { try { return typeof AppData !== 'undefined' ? AppData : window.AppData; } catch (_) { return window.AppData; } }
 function mount() {
  let bar = document.getElementById('anasDurabilityStatus');
  if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'anasDurabilityStatus'; bar.className = 'is-dirty';
  bar.setAttribute('role','status'); bar.setAttribute('aria-live','polite'); bar.textContent = 'الحفظ الدائم: جارٍ التحقق…';
  const header = document.querySelector('.top-navbar, .app-header, header');
  if (header && header.parentNode) header.insertAdjacentElement('afterend',bar);
  else document.body.insertBefore(bar,document.body.firstChild);
  return bar;
 }
 function refresh() {
  if (!document.body) return;
  const bar=mount(), storage=window.ANASResilientStorage, data=appData();
  if (!storage || !storage.ready || !storage.ready() || !storage.getCommittedSnapshot || !storage.canonicalizeJson || !data) {
   bar.className='is-dirty'; bar.textContent='الحفظ الدائم: جارٍ تجهيز التخزين'; return;
  }
  try {
   const committed=storage.getCommittedSnapshot();
   const equal=!!committed && storage.canonicalizeJson(committed)===storage.canonicalizeJson(data);
   const state=storage.status?storage.status():{}, offline=navigator.onLine===false;
   bar.className=equal?(offline?'is-offline':'is-saved'):'is-dirty';
   const revision=Number.isSafeInteger(state.revision)?' · مراجعة '+state.revision:'';
   bar.textContent=equal?(offline?'الحفظ الدائم: محفوظ محلياً · دون اتصال':'الحفظ الدائم: محفوظ ومتطابق')+revision:'الحفظ الدائم: تغييرات غير معتمدة بعد';
   bar.dataset.snapshotParity=equal?'match':'mismatch'; bar.dataset.storageMode=String(state.mode||'unknown');
  } catch (_) {
   bar.className='is-dirty'; bar.textContent='الحفظ الدائم: تعذّر التحقق؛ لا تعتبر البيانات محفوظة'; bar.dataset.snapshotParity='unknown';
  }
 }
 function start() {
  if (!document.body) return false;
  mount(); refresh(); window.addEventListener('online',refresh); window.addEventListener('offline',refresh);
  document.addEventListener('anas:storage-committed',refresh); document.addEventListener('anas:pos-cart-updated',refresh);
  window.setInterval(refresh,1500); return true;
 }
 if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
