(function(root){
'use strict';
function buildSupplierStatement(supplierId,suppliers,movements){
 if(!Array.isArray(suppliers)||!Array.isArray(movements)) throw new TypeError('دفتر الموردين غير صالح');
 const matches=suppliers.filter(s=>s&&typeof s==='object'&&!Array.isArray(s)&&String(s.id??'')===String(supplierId));
 if(matches.length!==1) throw new Error(matches.length?'معرّف المورد مكرر':'المورد غير موجود');
 const rows=movements.filter(m=>m&&typeof m==='object'&&!Array.isArray(m)&&String(m.supplierId??'')===String(matches[0].id)).slice().sort((a,b)=>{
  const x=Date.parse(a.date||''),y=Date.parse(b.date||'');
  if(!Number.isFinite(x)&&!Number.isFinite(y))return String(a.id||'').localeCompare(String(b.id||''));
  if(!Number.isFinite(x))return 1;if(!Number.isFinite(y))return -1;return x-y;
 });
 const totals={opening_balance:0,purchase:0,payment:0},valid={opening_balance:true,purchase:true,payment:true};
 for(const row of rows){if(!Object.prototype.hasOwnProperty.call(totals,row.type))continue;const n=Number(row.amount);const cents=Math.round(n*100);if(!Number.isFinite(n)||n<0||!Number.isSafeInteger(cents)||!Number.isSafeInteger(totals[row.type]+cents))valid[row.type]=false;else totals[row.type]+=cents;}
 return {supplier:matches[0],rows,totals,valid};
}

function showSupplierStatement(supplierId){
 const result=buildSupplierStatement(supplierId,AppData.suppliers,AppData.supplierMovements);
 const overlay=document.createElement('div');overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
 overlay.style.cssText='position:fixed;inset:0;z-index:100000;background:#0f172a99;display:flex;align-items:center;justify-content:center;padding:12px;';
 const panel=document.createElement('section');panel.style.cssText='width:min(900px,100%);max-height:90vh;overflow:auto;background:white;color:#111827;border-radius:14px;padding:16px;';
 const title=document.createElement('h2');title.textContent='كشف حساب المورد: '+String(result.supplier.name||'مورد بلا اسم');
 const close=document.createElement('button');close.type='button';close.textContent='إغلاق';close.onclick=()=>overlay.remove();panel.append(title,close);
 const money=n=>Number.isSafeInteger(n)?(n/100).toLocaleString('fr-DZ',{minimumFractionDigits:2,maximumFractionDigits:2})+' د.ج':'غير صالح';
 const summary=document.createElement('p');summary.textContent='الرصيد الحالي: '+money(Math.round(Number(result.supplier.balance||0)*100))+' | الرصيد الافتتاحي: '+money(result.totals.opening_balance)+' | المشتريات: '+money(result.totals.purchase)+' | التسديدات: '+money(result.totals.payment);panel.appendChild(summary);
 const table=document.createElement('table');table.style.cssText='width:100%;border-collapse:collapse;margin-top:12px;';
 const headings=['التاريخ','نوع الحركة','المرجع','المبلغ','ملاحظات'];const trh=document.createElement('tr');headings.forEach(v=>{const th=document.createElement('th');th.textContent=v;trh.appendChild(th);});table.appendChild(trh);
 result.rows.forEach(m=>{const tr=document.createElement('tr');[m.date||'—',m.type||'غير مصنف',m.referenceId||'—',money(Math.round(Number(m.amount)*100)),m.note||'—'].forEach(v=>{const td=document.createElement('td');td.textContent=String(v);td.style.cssText='padding:8px;border-top:1px solid #e2e8f0;';tr.appendChild(td);});table.appendChild(tr);});
 panel.appendChild(table);overlay.appendChild(panel);overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});document.body.appendChild(overlay);close.focus();
}
const originalRenderSuppliersDebts=root.renderSuppliersDebts;
if(typeof originalRenderSuppliersDebts==='function'){
 root.renderSuppliersDebts=function(){
  originalRenderSuppliersDebts.apply(this,arguments);
  const container=document.getElementById('suppDebtsContainer');if(!container||!Array.isArray(AppData.suppliers))return;
  Array.from(container.children).forEach((card,index)=>{const supplier=AppData.suppliers[index];if(!supplier||card.querySelector('[data-supplier-statement]'))return;
   const button=document.createElement('button');button.type='button';button.className='btn-pos-hasib';button.textContent='📄 كشف الحساب الكامل';button.setAttribute('data-supplier-statement','true');button.onclick=()=>{try{showSupplierStatement(supplier.id);}catch(e){alert('تعذر فتح كشف الحساب: '+(e.message||e));}};card.appendChild(button);
  });
 };
}
root.showSupplierStatement=showSupplierStatement;

root.anasBuildSupplierStatement=buildSupplierStatement;
if(typeof module!=='undefined'&&module.exports)module.exports={buildSupplierStatement};
})(typeof window!=='undefined'?window:globalThis);
