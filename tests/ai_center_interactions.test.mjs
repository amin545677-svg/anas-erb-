import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../anas-erp-ui-safe-enhancements.css', import.meta.url), 'utf8');

function hasFunction(name) {
  return new RegExp('function\\s+' + name + '\\s*\\(').test(html);
}

test('AI Center actions resolve to implemented handlers', () => {
  for (const name of [
    'renderAiHub', 'switchAiTab', 'anasSetAiPrompt', 'triggerAiGeneration',
    'handleSmartAiUpload', 'openInvoiceOcr', 'askAnasBusinessAI',
    'anasNormalizeAiGatewayUrl', 'anasDownloadPdfText', 'anasAskAiAboutPdf'
  ]) assert.ok(hasFunction(name), 'Missing AI Center handler: ' + name);
  assert.match(html, /<input\b[^>]*type="file"[^>]*id="smartAiExcelUpload"/);
  assert.match(html, /id="anasAiAskBtn"[^>]*data-anas-ai-action="ask"/);
  assert.match(html, /data-anas-ai-action="generate"/);
  assert.match(html, /data-anas-ai-action="import"/);
  assert.match(html, /data-anas-ai-action="ocr"/);
});

test('AI Center delegated listeners bind after DOM readiness and are idempotent', () => {
  assert.ok(html.includes("body.addEventListener('click'"), 'click events must be delegated from persistent document.body');
  assert.ok(html.includes("body.addEventListener('change'"), 'file input changes must be delegated from persistent document.body');
  assert.ok(html.includes("dataset.anasAiActionsBound === '1'"), 'binding must be idempotent');
  assert.ok(html.includes("document.addEventListener('DOMContentLoaded', bindAnasAiCenterActions"), 'binding must wait for DOM readiness if body is not yet available');
  assert.ok(!html.includes('stopImmediatePropagation()'), 'delegation must not suppress the click before the target handler can run');
});

test('ChatGPT helper opens, closes, sends and has an offline local fallback', () => {
  assert.match(html, /fab\.addEventListener\('click',\s*openPanel\)/);
  assert.match(html, /close\.addEventListener\('click',\s*closePanel\)/);
  assert.match(html, /send\.addEventListener\('click',\s*async function/);
  assert.match(html, /!url\s*\|\|\s*!navigator\.onLine/);
  assert.match(html, /وضع محلي — تعذر الاتصال بالخادم/);
});

test('AI Center mobile layout hides the floating assistant while keeping the panel and navigation available', () => {
  assert.match(css, /\.sub-header-bar\s*\{[^}]*position:\s*relative\s*!important/s);
  assert.match(html, /#anasContextAiFab\{display:none!important;pointer-events:none!important\}/);
  assert.match(css, /#anasContextAiPanel\s*\{[^}]*z-index:\s*81\s*!important/s);
  assert.match(html, /onclick="openView\('ai-excel-hub'\)"/, 'home card must open AI Center');
  assert.match(html, /closeDrawer\(\); openView\('ai-excel-hub'\)/, 'sidebar item must open AI Center');
});

test('ERP script and stylesheet references are relative for the /erp/ deployment path', () => {
  const rootRelativeAssets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["'](\/[^"']*)["']/gi)];
  assert.deepEqual(rootRelativeAssets.map(match => match[1]), [],
    'Found root-relative assets that can break below /erp/: ' + rootRelativeAssets.map(match => match[1]).join(', '));
});

test('Excel header analysis is local while PDF analysis retains its separate persisted-auth guard', () => {
  assert.match(html, /window\.anasGetFirebaseIdToken=async function\(timeoutMs=8000\)/);
  assert.match(html, /auth\.onAuthStateChanged\(u=>finish\(resolve,u\|\|null\)/);
  assert.match(html, /let resolvedUser=await new Promise/, 'Firebase auth state must remain assignable when anonymous sign-in creates the first user');
  assert.match(html, /auth\.signInAnonymously\(\)/, 'cloud AI should obtain a persisted anonymous Firebase identity when no user is signed in');
  assert.match(html, /المصادقة المجهولة غير مفعّلة في مشروع Firebase/, 'disabled anonymous provider must produce an actionable setup message');
  assert.match(html, /انتهت مهلة استعادة جلسة Firebase/);
  const start = html.indexOf('function showSmartImportPreview');
  const end = html.indexOf('function clearAllSalesInvoices', start);
  assert.ok(start >= 0 && end > start, 'smart import preview must remain available');
  const importSource = html.slice(start, end);
  assert.match(importSource, /smartImportAiAnalyze['"]\)\.click\(\)/, 'local header analysis must run automatically');
  assert.doesNotMatch(importSource, /anasGetFirebaseIdToken|Authorization:\s*['"]Bearer/);
  assert.match(html, /const firebaseIdToken=await window\.anasGetFirebaseIdToken\(\)/, 'PDF analysis may use its own persisted-auth guard');
});


test('cloud AI creates an anonymous Firebase session when ERP is used without manual sign-in', async () => {
  const start = html.indexOf('window.anasGetFirebaseIdToken=async function(timeoutMs=8000)');
  const end = html.indexOf('// Restore Firebase\'s persisted state', start);
  assert.ok(start >= 0 && end > start, 'Firebase token helper must be isolatable');
  const helper = html.slice(start, end);
  let anonymousCalls = 0;
  const user = { getIdToken: async () => 'signed-firebase-id-token' };
  const auth = {
    currentUser: null,
    onAuthStateChanged(callback) { callback(null); return () => {}; },
    signInAnonymously: async () => { anonymousCalls++; auth.currentUser = user; return { user }; }
  };
  const window = {};
  vm.runInNewContext(helper, { window, auth, anonymousSignInPromise: null, setTimeout, clearTimeout, Error, String, Number });
  assert.equal(await window.anasGetFirebaseIdToken(), 'signed-firebase-id-token');
  assert.equal(anonymousCalls, 1, 'anonymous sign-in must be attempted exactly once');
  const concurrentAuth = {
    currentUser: null,
    onAuthStateChanged(callback) { callback(null); return () => {}; },
    signInAnonymously: async () => {
      anonymousCalls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrentAuth.currentUser = user;
      return { user };
    }
  };
  const concurrentWindow = {};
  vm.runInNewContext(helper, { window: concurrentWindow, auth: concurrentAuth, anonymousSignInPromise: null, setTimeout, clearTimeout, Error, String, Number });
  const beforeConcurrent = anonymousCalls;
  const tokens = await Promise.all([concurrentWindow.anasGetFirebaseIdToken(), concurrentWindow.anasGetFirebaseIdToken()]);
  assert.deepEqual(tokens, ['signed-firebase-id-token', 'signed-firebase-id-token']);
  assert.equal(anonymousCalls - beforeConcurrent, 1, 'concurrent requests must share one anonymous sign-in');

  const disabledAuth = {
    onAuthStateChanged(callback) { callback(null); return () => {}; },
    signInAnonymously: async () => { const error = new Error('provider disabled'); error.code = 'auth/operation-not-allowed'; throw error; }
  };
  const disabledWindow = {};
  vm.runInNewContext(helper, { window: disabledWindow, auth: disabledAuth, anonymousSignInPromise: null, setTimeout, clearTimeout, Error, String, Number });
  await assert.rejects(disabledWindow.anasGetFirebaseIdToken(), /المصادقة المجهولة غير مفعّلة/);
});

test('Excel and PDF parsers are bundled locally and not loaded from runtime CDNs', () => {
  assert.match(html, /src="\.\/vendor\/xlsx\/xlsx\.full\.min\.js"/);
  assert.match(html, /src="\.\/vendor\/pdfjs\/pdf\.min\.js"/);
  assert.match(html, /new URL\('\.\/vendor\/pdfjs\/pdf\.worker\.min\.js'/);
  assert.doesNotMatch(html, /cdn\.sheetjs\.com|cdn\.jsdelivr\.net\/npm\/xlsx|cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js/);
  assert.match(html, /مطابقة الأعمدة/);
  assert.match(html, /تحليل الأعمدة محلياً دون اتصال/);
  assert.match(html, /ANAS_ERP_PRE_IMPORT_BACKUP_V1/);
});

test('store movement report toolbar wraps on mobile without vertically breaking action labels', () => {
  assert.match(css, /#anasReportToolbar\s*\{[^}]*display:\s*flex\s*!important[^}]*flex-wrap:\s*wrap\s*!important/s);
  assert.match(css, /#anasReportToolbar button\s*\{[^}]*flex:\s*0 0 auto\s*!important[^}]*white-space:\s*nowrap\s*!important/s);
});

test('AI Center auto-runs local inventory valuation and accepts unitless Arabic sale commands', () => {
  const start = html.indexOf('function anasPrepareNaturalLanguageDraft()');
  const end = html.indexOf('function anasConvertNaturalDraftToSale(form)', start);
  assert.ok(start >= 0 && end > start, 'natural-language sales parser must be present');
  const parser = html.slice(start, end);
  assert.ok(parser.includes("const qtyMatch=raw.match(new RegExp('(?:بيع|شراء|اشتر|أضف|اضف|كمية|عدد|بكمية)"), 
    'quantity extraction must accept a numeric quantity without a unit word');
  assert.ok(parser.includes('بسعر') && parser.includes('للعميل'));
  const openStart = html.indexOf('function openView(viewName');
  const openEnd = html.indexOf('function old_openQuickSale', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = html.slice(openStart, openEnd);
  assert.ok(open.includes("if(viewName === 'ai-excel-hub')") && open.includes('anasRunLocalBusinessAudit()'));
  assert.ok(html.includes('stockCost,stockSell'));
  assert.ok(html.includes('قيمة المخزون بسعر الشراء'));
  assert.ok(html.includes('قيمة المخزون بسعر البيع'));
  assert.ok(html.includes('max-height: 85dvh') && html.includes('overflow-y: auto'));
});
