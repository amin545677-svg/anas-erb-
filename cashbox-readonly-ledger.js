(function(root){
'use strict';
function buildCashLedger(movements,query='',filter='all'){
 if(!Array.isArray(movements))throw new TypeError('سجل الحركات النقدية غير صالح');
 const all=movements.map((m,index)=>{
  const object=!!m&&typeof m==='object'&&!Array.isArray(m),type=object?m.type:'';
  const amount=object?Number(m.amount):NaN,cents=Math.round(amount*100);
  const valid=object&&(type==='add'||type==='subtract')&&Number.isFinite(amount)&&amount>0&&Number.isSafeInteger(cents);
  const reference=object?[m.referenceType,m.referenceId].filter(v=>v!=null&&String(v).trim()).join(' / '):'';
  const date=object&&m.date?new Date(m.date):null,time=date&&Number.isFinite(date.getTime())?date.getTime():-1;
  return {index,valid,type,cents,time,date:time>=0?date.toISOString():'',description:object?String(m.description||m.desc||'—'):'سجل غير صالح',user:object?String(m.userName||m.userId||'غير محدد'):'—',reference:reference||'—',searchable:object?[m.id,m.description,m.desc,m.userName,m.userId,reference].join(' ').toLocaleLowerCase():''};
 });
 const q=String(query||'').trim().toLocaleLowerCase(),valid=all.filter(x=>x.valid);
 const filtered=all.filter(x=>(filter==='all'||(filter==='invalid'?!x.valid:x.valid&&x.type===filter))&&(!q||x.searchable.includes(q))).sort((a,b)=>b.time-a.time||b.index-a.index);
 const incoming=valid.filter(x=>x.type==='add').reduce((n,x)=>n+x.cents,0),outgoing=valid.filter(x=>x.type==='subtract').reduce((n,x)=>n+x.cents,0);
 return {rows:filtered,total:all.length,invalid:all.length-valid.length,incoming:Number.isSafeInteger(incoming)?incoming:null,outgoing:Number.isSafeInteger(outgoing)?outgoing:null};
}
root.anasBuildCashLedger=buildCashLedger;
if(typeof module!=='undefined'&&module.exports)module.exports={buildCashLedger};
})(typeof window!=='undefined'?window:globalThis);
