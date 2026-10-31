(function(root){
'use strict';
function anasNormalizeQueryText(value){
 return String(value??'').normalize('NFKC').toLocaleLowerCase('ar')
 .replace(/[\\u064B-\\u065F\\u0670\\u0640]/g,'')
 .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي')
 .replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660))
 .replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x06F0))
 .replace(/\\s+/g,' ').trim();
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
root.anasNormalizeQueryText=anasNormalizeQueryText;root.anasQueryMatches=anasQueryMatches;root.anasQueryScore=anasQueryScore;
if(typeof module!=='undefined'&&module.exports)module.exports={anasNormalizeQueryText,anasQueryMatches,anasQueryScore};
})(typeof window!=='undefined'?window:globalThis);
