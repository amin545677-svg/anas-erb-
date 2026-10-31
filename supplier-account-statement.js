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
root.anasBuildSupplierStatement=buildSupplierStatement;
if(typeof module!=='undefined'&&module.exports)module.exports={buildSupplierStatement};
})(typeof window!=='undefined'?window:globalThis);
