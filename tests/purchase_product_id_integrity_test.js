const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function savePurchaseItem() {');
const end = html.indexOf('\n        function ', start + 20);
assert.ok(start >= 0 && end > start, 'savePurchaseItem must be present and isolatable');
const source = html.slice(start, end);
const guardAt = source.indexOf('const productIds = new Set()');
const mutationAt = source.indexOf('AppData.purchases.unshift(');
assert.ok(guardAt >= 0, 'purchase must validate product ID uniqueness');
assert.ok(mutationAt > guardAt, 'duplicate product IDs must be rejected before any purchase or stock mutation');
assert.ok(source.includes('productIds.has(recordId)'), 'purchase must detect repeated non-empty product IDs');
assert.ok(source.includes('existingProduct.id === undefined || existingProduct.id === null || String(existingProduct.id).trim() === \'\''), 'purchase must reject a same-name product without a stable ID');
assert.ok(source.indexOf('لا يملك معرّفًا صالحًا') < mutationAt, 'missing product identity must be rejected before stock or purchase mutation');
assert.ok(source.includes('معرّف المنتج مكرر'), 'duplicate-ID rejection must explain the reason to the operator');
console.log('Purchase product identity integrity checks passed');
