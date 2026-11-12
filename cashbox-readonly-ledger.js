(function(root){
'use strict';
function parseCashCentimes(value){
 if((typeof value!=='number'&&typeof value!=='string')||String(value).trim()==='')return null;
 const match=/^(0|[1-9]\\d*)(?:\\.(\\d{1,2}))?$/.exec(String(value).trim());
 if(!match)return null;
 const cents=BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0')||'0');
 return cents<=BigInt(Number.MAX_SAFE_INTEGER)?Number(cents):null;
}
function buildCashLedger(movements,query='',filter='all'){
 if(!Array.isArray(movements))throw new TypeError('سجل الحركات النقدية غير صالح');
 const cashOnly=movements.filter(m=>!(m&&typeof m==='object'&&(m.cashImpact===false||(m.paymentChannel&&m.paymentChannel!=='cash'))));
 const all=cashOnly.map((m,index)=>{
  const object=!!m&&typeof m==='object'&&!Array.isArray(m),type=object?m.type:'';
  const cents=object?parseCashCentimes(m.amount):null;
  const valid=object&&(type==='add'||type==='subtract')&&cents!==null&&cents>0;
  const reference=object?[m.referenceType,m.referenceId].filter(v=>v!=null&&String(v).trim()).join(' / '):'';
  const date=object&&m.date?new Date(m.date):null,time=date&&Number.isFinite(date.getTime())?date.getTime():-1;
  return {index,valid,type,cents,time,date:time>=0?date.toISOString():'',description:object?String(m.description||m.desc||'—'):'سجل غير صالح',user:object?String(m.userName||m.userId||'غير محدد'):'—',reference:reference||'—',searchable:object?[m.id,m.description,m.desc,m.userName,m.userId,reference].join(' ').toLocaleLowerCase():''};
 });
 const q=String(query||'').trim().toLocaleLowerCase(),valid=all.filter(x=>x.valid);
 const filtered=all.filter(x=>(filter==='all'||(filter==='invalid'?!x.valid:x.valid&&x.type===filter))&&(!q||x.searchable.includes(q))).sort((a,b)=>b.time-a.time||b.index-a.index);
 const sumCents=rows=>{let total=0n;for(const row of rows)total+=BigInt(row.cents);return total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):null;};
 const incoming=sumCents(valid.filter(x=>x.type==='add')),outgoing=sumCents(valid.filter(x=>x.type==='subtract'));
 return {rows:filtered,total:all.length,invalid:all.length-valid.length,incoming,outgoing};
}

function renderCashLedgerUI(){
 const host=document.querySelector('#view-cash > .panel-card-form');if(!host)return;
 let panel=document.getElementById('anasCashReadonlyLedger');
 if(!panel){panel=document.createElement('section');panel.id='anasCashReadonlyLedger';panel.style.cssText='margin-top:14px;padding:12px;border:1px solid #cbd5e1;border-radius:10px;';
  const title=document.createElement('h3');title.textContent='📒 سجل الحركات النقدية المسجلة (قراءة فقط)';panel.appendChild(title);
  const search=document.createElement('input');search.id='anasCashLedgerSearch';search.type='search';search.placeholder='ابحث بالبيان أو المستخدم أو المرجع';search.style.cssText='width:100%;padding:9px;margin:8px 0;';
  const filter=document.createElement('select');filter.id='anasCashLedgerType';filter.style.cssText='width:100%;padding:9px;margin-bottom:8px;';
  [['all','كل الحركات'],['add','المقبوضات'],['subtract','المدفوعات'],['invalid','السجلات غير الصالحة']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;filter.appendChild(o);});
  const summary=document.createElement('p');summary.id='anasCashLedgerSummary';const table=document.createElement('table');table.style.cssText='width:100%;border-collapse:collapse;font-size:12px;';
  const head=document.createElement('tr');['التاريخ','النوع','البيان','المبلغ','المستخدم','المرجع'].forEach(v=>{const th=document.createElement('th');th.textContent=v;head.appendChild(th);});
  const thead=document.createElement('thead');thead.appendChild(head);const tbody=document.createElement('tbody');tbody.id='anasCashLedgerRows';table.append(thead,tbody);
  const note=document.createElement('p');note.textContent='يعرض الحركات النقدية فقط من cashMovements، ويستبعد الشيكات والتحويلات والبطاقات حتى لو وُجدت بسجل قديم؛ لا يعدّل أي حركة.';note.style.cssText='font-size:11px;color:#64748b;';
  panel.append(search,filter,summary,table,note);host.appendChild(panel);
  search.addEventListener('input',renderCashLedgerUI);filter.addEventListener('change',renderCashLedgerUI);
 }
 const summary=document.getElementById('anasCashLedgerSummary'),body=document.getElementById('anasCashLedgerRows');if(!summary||!body)return;
 let result;try{result=buildCashLedger(AppData.cashMovements,document.getElementById('anasCashLedgerSearch').value,document.getElementById('anasCashLedgerType').value);}catch(e){summary.textContent='سجل الحركات غير متاح أو تالف: '+(e.message||e);body.replaceChildren();return;}
 const money=n=>Number.isSafeInteger(n)?(n/100).toLocaleString('fr-DZ',{minimumFractionDigits:2,maximumFractionDigits:2})+' د.ج':'غير متاح';
 summary.textContent='السجلات: '+result.total+' | المقبوضات: '+money(result.incoming)+' | المدفوعات: '+money(result.outgoing)+' | تحتاج مراجعة: '+result.invalid;
 body.replaceChildren();result.rows.forEach(row=>{const tr=document.createElement('tr');[row.date?new Date(row.date).toLocaleString('ar-DZ'):'تاريخ غير صالح',!row.valid?'غير صالح':row.type==='add'?'قبض':'صرف',row.description,row.valid?money(row.cents):'قيمة غير صالحة',row.user,row.reference].forEach(v=>{const td=document.createElement('td');td.textContent=String(v);td.style.cssText='padding:7px;border-top:1px solid #e2e8f0;';tr.appendChild(td);});body.appendChild(tr);});
 if(!result.rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='لا توجد نتائج مطابقة';tr.appendChild(td);body.appendChild(tr);}
}
const originalUpdateCashUI=root.updateCashUI;
if(typeof originalUpdateCashUI==='function')root.updateCashUI=function(){originalUpdateCashUI.apply(this,arguments);renderCashLedgerUI();};
root.anasRenderCashLedger=renderCashLedgerUI;

function expectedClosingCash(openingCash, cashMovements, bankMovements = []) {
 if (!Array.isArray(cashMovements)) throw new TypeError('سجل الحركات النقدية غير صالح');
 const toCents = value => {
  const raw=String(value??'0').trim().replace(',','.');
  const match=/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw);
  if(!match)throw new TypeError('قيمة نقدية غير صالحة');
  return BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'));
 };
 let total=toCents(openingCash);
 for(const movement of cashMovements){
  if(!movement||typeof movement!=='object'||Array.isArray(movement))continue;
  if(movement.cashImpact===false||(movement.paymentChannel&&movement.paymentChannel!=='cash'))continue;
  if(movement.type!=='add'&&movement.type!=='subtract')continue;
  const amount=toCents(movement.amount);
  if(amount<=0n)throw new RangeError('حركة الصندوق يجب أن تكون أكبر من صفر');
  total+=movement.type==='add'?amount:-amount;
 }
 // Bank, cheque, card and transfer movements are intentionally excluded from physical cash.
 void bankMovements;
 if(total<0n||total>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('رصيد الإقفال النقدي خارج المجال الآمن');
 return Number(total);
}
root.expectedClosingCash=expectedClosingCash;
root.anasBuildCashLedger=buildCashLedger;
if(typeof module!=='undefined'&&module.exports)module.exports={buildCashLedger,expectedClosingCash};
})(typeof window!=='undefined'?window:globalThis);
