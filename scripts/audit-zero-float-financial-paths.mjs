#!/usr/bin/env node
'use strict';

// Read-only static financial-path audit. Numeric Number conversion is allowed only
// at explicitly bounded safe-integer serialization boundaries; financial arithmetic
// and decimal quantity normalization must remain BigInt/string based.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = [
  'reverse-ledger/reverse-ledger.js',
  'reverse-ledger/authorization.js',
  'functions/reverse-ledger-service.js',
  'functions/reverse-ledger-adapter.js',
  'functions/settlement-allocation-service.js'
];
const sources = new Map(files.map(path => {
  assert.ok(fs.existsSync(path), 'Required financial module is missing: ' + path);
  return [path, fs.readFileSync(path, 'utf8')];
}));
const shell = fs.readFileSync('index.html', 'utf8');
const checkoutStart = shell.indexOf('async function confirmHasibPaymentDurable()');
const inputStart = shell.indexOf('for (const item of cart)', checkoutStart);
const inputEnd = shell.indexOf('const discountCents =', inputStart);
assert.ok(checkoutStart >= 0 && inputStart > checkoutStart && inputEnd > inputStart, 'V42 POS durable checkout input loop must be auditable');
const checkoutInput = shell.slice(inputStart, inputEnd);
assert.doesNotMatch(checkoutInput, /\bNumber\s*\(\s*item\.(?:qty|price)\s*\)/,
  'POS checkout must not convert raw quantity/price through Number before BigInt parsing');
assert.match(checkoutInput, /const qtyRaw = String\(item\.qty\)\.trim\(\)/, 'raw quantity text is retained');
assert.match(checkoutInput, /const priceRaw = String\(item\.price\)\.trim\(\)/, 'raw unit-price text is retained');
assert.match(checkoutInput, /anasToQtyUnits\(qtyRaw\)/, 'quantity is parsed from raw text');
assert.match(checkoutInput, /anasToCents\(priceRaw\)/, 'price is parsed from raw text');
const decimalParserStart = shell.indexOf('function anasDecimalToScaledInteger');
const decimalParserEnd = shell.indexOf('function anasToCents', decimalParserStart);
assert.ok(decimalParserStart >= 0 && decimalParserEnd > decimalParserStart, 'BigInt decimal parser must be present');
const decimalParser = shell.slice(decimalParserStart, decimalParserEnd);
assert.match(decimalParser, /BigInt\(match\[4\]\)/, 'decimal exponent is parsed as BigInt');
assert.doesNotMatch(decimalParser, /Number\(match\[4\]\)/, 'raw decimal exponent does not pass through Number');
const violations = [];
for (const [path, source] of sources) {
  const checks = [
    [/\bparseFloat\s*\(/g, 'parseFloat is forbidden in financial paths'],
    [/Math\.(?:abs|round|floor|ceil)\s*\(\s*Number\s*\(/g, 'floating-point math over a financial quantity is forbidden'],
    [/\bNumber\s*\(\s*(?:rawQty|rawAmount|rawCentimes|rawMicroUnits|quantity|qty|centimes|microUnits|unitPrice|lineTotal|originalLineTotal|originalQuantity|previousQuantity|nextUnits|nextWacCentimes|partyDebt|debtReduction|customerCredit|supplierCredit|supplierAmount|cashAfter|cashRefund|totalCentimes|restoredInventoryCostCentimes|inventoryBookValueCentimes)\b/gi,
      'unbounded Number conversion of a raw financial quantity is forbidden']
  ];
  for (const [pattern, message] of checks) {
    for (const match of source.matchAll(pattern)) {
      violations.push(path + ': ' + message + ' at offset ' + match.index);
    }
  }
}
const requireText = (path, pattern, description) => {
  const source = sources.get(path) || '';
  assert.match(source, pattern, path + ' must retain ' + description);
};
requireText('reverse-ledger/reverse-ledger.js', /BigInt\(match\[1\]\)/, 'BigInt decimal parsing');
requireText('reverse-ledger/reverse-ledger.js', /function signedQuantity\s*\(/, 'string-based signed quantity validation');
requireText('reverse-ledger/reverse-ledger.js', /const toSafeIntegerNumber =/, 'bounded BigInt-to-safe-integer serialization');
requireText('reverse-ledger/authorization.js', /authorizeReverseOperation/, 'reverse-operation authorization');
requireText('reverse-ledger/authorization.js', /PERMISSIONS/, 'the canonical permission matrix');
requireText('functions/reverse-ledger-service.js', /authorizeFinancialScope/, 'financial RBAC scope enforcement');
requireText('functions/reverse-ledger-service.js', /operationRef/, 'durable operation identity');
requireText('functions/reverse-ledger-service.js', /transaction\.(?:create|update)\(operationRef/, 'transactional idempotency record');
requireText('functions/settlement-allocation-service.js', /authorizeFinancialScope/, 'settlement financial RBAC');
requireText('functions/settlement-allocation-service.js', /operationRef/, 'settlement idempotency identity');
requireText('functions/settlement-allocation-service.js', /transaction\.create\(operationRef/, 'atomic settlement idempotency creation');
requireText('functions/reverse-ledger-adapter.js', /authorizePreparedReverseOperation/, 'prepared reverse-operation authorization');
requireText('functions/reverse-ledger-adapter.js', /BigInt\(postedDocument\.(?:customer|supplier)CreditCentimes/, 'BigInt credit aggregation');

assert.deepEqual(violations, [], 'Zero-float financial-path violations detected:\n' + violations.join('\n'));
console.log(JSON.stringify({
  audit: 'PASS',
  filesChecked: files.length,
  forbiddenFloatParsers: 0,
  unboundedFinancialNumberConversions: 0,
  bigintArithmetic: 'required',
  rbac: 'required',
  idempotency: 'required',
  note: 'Bounded Number(BigInt) conversions are permitted only after explicit MAX_SAFE_INTEGER checks at API/storage boundaries.',
  posShell: 'raw quantity/price text is parsed through BigInt before safe Number serialization'
}, null, 2));
