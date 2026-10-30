(function () {
'use strict';
if (window.ANASReverseLedgerModal) return;
const MODES = Object.freeze({
 SALE_RETURN:{title:'مرتجع مبيعات',invoices:'invoices'},
 PURCHASE_RETURN:{title:'مرتجع مشتريات',invoices:'purchases'},
 INVOICE_CANCEL:{title:'إلغاء فاتورة',invoices:'invoices'}
});
const byId=id=>document.getElementById(id);
const state={mode:null,invoice:null};
const money=value=>{
 const raw=String(value??'0').trim().replace(/\s/g,'').replace(',','.');
 if(!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
 const p=raw.split('.');
 return BigInt(p[0])*100n+BigInt((p[1]||'').padEnd(2,'0'));
};
const formatMoney=c=>(c/100n).toString()+'.'+(c%100n).toString().padStart(2,'0');
function mount(){
 if(byId('modal-reverse-ledger')) return;
 const style=document.createElement('style'); style.id='anas-reverse-ledger-style';
 style.textContent='#modal-reverse-ledger{position:fixed;inset:0;z-index:10020;background:rgba(15,23,42,.58);display:none;align-items:center;justify-content:center;padding:12px}'+
 '#modal-reverse-ledger.active{display:flex}#modal-reverse-ledger .rev-dialog{width:min(920px,100%);max-height:92vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.28);direction:rtl;color:#0f172a}'+
 '#modal-reverse-ledger .rev-head{position:sticky;top:0;background:#1e3a6d;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;z-index:1}'+
 '#modal-reverse-ledger .rev-head h2{font-size:1.05rem;margin:0}#modal-reverse-ledger .rev-close{border:0;background:transparent;color:#fff;font-size:1.5rem;cursor:pointer;padding:2px 8px}'+
 '#modal-reverse-ledger .rev-body{padding:14px;display:grid;gap:14px}#modal-reverse-ledger .rev-section{border:1px solid #dbe3ed;border-radius:10px;padding:12px;display:grid;gap:10px;min-width:0}'+
 '#modal-reverse-ledger .rev-section h3{font-size:.92rem;color:#1e3a6d;margin:0}#modal-reverse-ledger label{font-size:.82rem;font-weight:700;display:grid;gap:6px}'+
 '#modal-reverse-ledger input,#modal-reverse-ledger select{width:100%;min-width:0;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;background:#fff;color:#0f172a}'+
 '#modal-reverse-ledger input:focus,#modal-reverse-ledger select:focus{outline:2px solid #93c5fd;border-color:#2563eb}#modal-reverse-ledger .rev-status{border-radius:8px;padding:10px;background:#fff7ed;color:#9a3412;font-size:.82rem;font-weight:700}'+
 '#modal-reverse-ledger .rev-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}#modal-reverse-ledger .rev-items{overflow:auto;border:1px solid #e2e8f0;border-radius:8px;min-height:64px}'+
 '#modal-reverse-ledger .rev-items table{width:100%;border-collapse:collapse;min-width:620px;font-size:.8rem}#modal-reverse-ledger .rev-items th,#modal-reverse-ledger .rev-items td{padding:9px;border-bottom:1px solid #e2e8f0;text-align:center}#modal-reverse-ledger .rev-items th{background:#f1f5f9}'+
 '#modal-reverse-ledger .rev-preview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#modal-reverse-ledger .rev-preview>div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px}#modal-reverse-ledger .rev-preview small{display:block;color:#64748b;margin-bottom:4px}'+
 '#modal-reverse-ledger .rev-preview strong{font-variant-numeric:tabular-nums}#modal-reverse-ledger .rev-actions{display:flex;gap:8px;justify-content:flex-start;flex-wrap:wrap}#modal-reverse-ledger .rev-actions button{border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:800;cursor:pointer}'+
 '#rev-submit-btn{background:#94a3b8;color:#fff;cursor:not-allowed!important}#rev-cancel-btn{background:#e2e8f0;color:#334155}'+
 '@media(max-width:560px){#modal-reverse-ledger{padding:0;align-items:flex-end}#modal-reverse-ledger .rev-dialog{width:100%;max-height:96vh;border-radius:14px 14px 0 0}#modal-reverse-ledger .rev-body{padding:10px}#modal-reverse-ledger .rev-grid,#modal-reverse-ledger .rev-preview{grid-template-columns:1fr}}';
 document.head.appendChild(style);
 const overlay=document.createElement('div'); overlay.id='modal-reverse-ledger'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-labelledby','rev-modal-title');
 overlay.innerHTML='<div class="rev-dialog"><div class="rev-head"><h2 id="rev-modal-title">التسوية العكسية</h2><button type="button" class="rev-close" aria-label="إغلاق" id="rev-close-btn">×</button></div>'+
 '<div class="rev-body"><section class="rev-section"><h3>1. الفاتورة والأهلية</h3><label>اختر الفاتورة<select id="rev-invoice-select"><option value="">اختر الفاتورة...</option></select></label><div id="rev-eligibility-status" class="rev-status" role="status" aria-live="polite">اختر فاتورة لبدء فحص الأهلية.</div></section>'+
 '<section class="rev-section"><h3>2. الأصناف والكميات</h3><div class="rev-items"><table><thead><tr><th>الصنف</th><th>الكمية الأصلية</th><th>المرتجع سابقاً</th><th>المتاح</th><th>المخزون الحالي</th><th>كمية الإرجاع الآن</th><th>قيمة السطر</th></tr></thead><tbody id="rev-items-body"><tr><td colspan="7">اختر فاتورة لعرض الأصناف.</td></tr></tbody></table></div></section>'+
 '<section class="rev-section"><h3>3. المعاينة المالية</h3><div class="rev-preview"><div><small>إجمالي المرتجع</small><strong id="rev-preview-total">0.00 د.ج</strong></div><div><small>المتبقي على الفاتورة</small><strong id="rev-preview-invoice-remaining">—</strong></div><div><small>تخفيض الدين</small><strong id="rev-preview-debt-reduction">0.00 د.ج</strong></div><div><small>الفائض النقدي / الدائن</small><strong id="rev-preview-cash-excess">0.00 د.ج</strong></div></div>'+
 '<div class="rev-grid"><label>طريقة معالجة الفائض<select id="rev-excess-mode"><option value="cash">نقداً</option><option value="credit">رصيد دائن</option></select></label><label>سبب العملية<input id="rev-reason-input" maxlength="500" placeholder="سبب الإرجاع أو الإلغاء"></label></div></section>'+
 '<div class="rev-actions"><button type="button" id="rev-submit-btn" disabled>تأكيد الترحيل</button><button type="button" id="rev-cancel-btn">إغلاق</button></div><p style="font-size:.75rem;color:#64748b">مرحلة تأسيس الواجهة: الترحيل معطّل عمداً حتى اكتمال محرك الأهلية والحسابات والاختبارات. لا يتم تعديل أي سجل من هذه النافذة حالياً.</p></div></div>';
 document.body.appendChild(overlay);
 byId('rev-close-btn').addEventListener('click',close); byId('rev-cancel-btn').addEventListener('click',close);
 overlay.addEventListener('click',e=>{if(e.target===overlay)close()});
 byId('rev-invoice-select').addEventListener('change',onInvoiceChange);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('active'))close()});
}
function invoiceLabel(invoice,index,mode){
 const id=String(invoice.id), number=String(invoice.invoiceNumber??invoice.number??invoice.code??id);
 const party=mode==='PURCHASE_RETURN'?(invoice.supplier?.name??invoice.supplierName):(invoice.customer?.name??invoice.customerName);
 const total=money(invoice.total);
 return number+' — '+String(party??'طرف غير محدد')+' — '+(total===null?'قيمة غير صالحة':formatMoney(total)+' د.ج');
}
function onInvoiceChange(){
 const rows=window.AppData&&Array.isArray(AppData[MODES[state.mode].invoices])?AppData[MODES[state.mode].invoices]:[];
 const matches=rows.filter(x=>x&&String(x.id)===byId('rev-invoice-select').value);
 state.invoice=matches.length===1?matches[0]:null;
 byId('rev-items-body').textContent=state.invoice?'لم يتم ربط محلل أصناف الفاتورة بعد.':'اختر فاتورة لعرض الأصناف.';
 byId('rev-eligibility-status').textContent=state.invoice?'الفاتورة محددة، لكن الأهلية لم تُعتمد بعد. الترحيل محجوب حتى اكتمال فحص دفتر التخصيصات والحركات.':'اختر فاتورة لبدء فحص الأهلية.';
 byId('rev-preview-invoice-remaining').textContent=state.invoice?'بانتظار محرك المعاينة':'—';
 byId('rev-submit-btn').disabled=true;
}
function open(mode){
 if(!MODES[mode])throw new Error('Unsupported reverse-ledger mode');
 mount(); state.mode=mode; state.invoice=null;
 byId('rev-modal-title').textContent=MODES[mode].title;
 const select=byId('rev-invoice-select'); select.replaceChildren(new Option('اختر الفاتورة...',''));
 const rows=window.AppData&&Array.isArray(AppData[MODES[mode].invoices])?AppData[MODES[mode].invoices]:[];
 rows.forEach((invoice,index)=>{if(invoice&&invoice.id!=null)select.add(new Option(invoiceLabel(invoice,index,mode),String(invoice.id)))});
 byId('rev-reason-input').value=''; byId('rev-items-body').textContent='اختر فاتورة لعرض الأصناف.';
 byId('rev-eligibility-status').textContent=rows.length?'اختر فاتورة لبدء فحص الأهلية.':'لا توجد فواتير متاحة في هذا السجل.';
 byId('rev-preview-total').textContent='0.00 د.ج'; byId('rev-preview-invoice-remaining').textContent='—';
 byId('rev-preview-debt-reduction').textContent='0.00 د.ج'; byId('rev-preview-cash-excess').textContent='0.00 د.ج';
 byId('rev-submit-btn').disabled=true; byId('modal-reverse-ledger').classList.add('active'); select.focus();
}
function close(){const modal=byId('modal-reverse-ledger');if(modal)modal.classList.remove('active')}
window.ANASReverseLedgerModal=Object.freeze({open:open,close:close,modes:MODES});
window.returnSalePrompt=function(){open('SALE_RETURN')};
window.returnPurchasePrompt=function(){open('PURCHASE_RETURN')};
window.cancelInvoicePrompt=function(){open('INVOICE_CANCEL')};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();