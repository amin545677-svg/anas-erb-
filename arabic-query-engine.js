(function(root){
'use strict';
const slash=String.fromCharCode(92);
const marks=new RegExp('['+String.fromCharCode(0x064B)+'-'+String.fromCharCode(0x065F)+String.fromCharCode(0x0670)+String.fromCharCode(0x0640)+']','g');
const spaces=new RegExp(slash+'s+','g');
function anasNormalizeQueryText(value){
 return String(value??'').normalize('NFKC').toLocaleLowerCase('ar').replace(marks,'')
 .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي')
 .replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660))
 .replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x06F0))
 .replace(spaces,' ').trim();
}
function anasQueryMatches(fields,query){
 const q=anasNormalizeQueryText(query);if(!q)return true;
 const values=Array.isArray(fields)?fields:[fields];
 const haystack=anasNormalizeQueryText(values.filter(v=>v!=null).join(' '));
 return q.split(' ').filter(Boolean).every(token=>haystack.includes(token));
}
function anasQueryScore(fields,query){
 const q=anasNormalizeQueryText(query);if(!q)return 0;
 const values=(Array.isArray(fields)?fields:[fields]).map(anasNormalizeQueryText);
 if(values.some(v=>v===q))return 100;if(values.some(v=>v.startsWith(q)))return 70;if(values.some(v=>v.includes(q)))return 50;return 10;
}

root.normalizePosSearch=anasNormalizeQueryText;
root.handlePosSearch=function(query){
 const input=document.getElementById('posSearchField'),results=document.getElementById('posSearchResults');
 if(!input||!results)return;const q=anasNormalizeQueryText(query);if(!q){results.hidden=true;results.replaceChildren();return;}
 const products=Array.isArray(AppData&&AppData.products)?AppData.products:[];
 const matches=products.map((p,index)=>({p,index,score:anasQueryScore([p.name,p.barcode,p.sku,p.code],q)}))
  .filter(x=>anasQueryMatches([x.p.name,x.p.barcode,x.p.sku,x.p.code],q))
  .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,12);
 results.replaceChildren();
 if(!matches.length){const empty=document.createElement('div');empty.className='pos-search-empty';empty.textContent='لا توجد منتجات مطابقة';results.appendChild(empty);results.hidden=false;return;}
 matches.forEach(({p})=>{const button=document.createElement('button');button.type='button';button.className='pos-search-result';button.setAttribute('role','option');
  const name=document.createElement('span');name.className='pos-search-result-name';name.textContent=String(p.name||'');
  const meta=document.createElement('span');meta.className='pos-search-result-meta';const price=AppData.activePriceTier===2?(p.price2||p.price1):AppData.activePriceTier===3?(p.price3||p.price1):p.price1;meta.textContent=String(p.barcode||'بدون باركود')+' · '+Number(price||0).toLocaleString('fr-DZ')+' د.ج';button.append(name,meta);
  button.addEventListener('click',()=>{if(typeof root.selectPosSearchProduct==='function')root.selectPosSearchProduct(p.id);});results.appendChild(button);
 });
 results.hidden=false;
};

root.anasNormalizeQueryText=anasNormalizeQueryText;root.anasQueryMatches=anasQueryMatches;root.anasQueryScore=anasQueryScore;
if(typeof module!=='undefined'&&module.exports)module.exports={anasNormalizeQueryText,anasQueryMatches,anasQueryScore};
})(typeof window!=='undefined'?window:globalThis);
