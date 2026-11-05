import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  assert.match(html, /<input\\b[^>]*type="file"[^>]*id="smartAiExcelUpload"/);
  assert.match(html, /id="anasAiAskBtn"[^>]*data-anas-ai-action="ask"/);
  assert.match(html, /data-anas-ai-action="generate"/);
  assert.match(html, /data-anas-ai-action="import"/);
  assert.match(html, /data-anas-ai-action="ocr"/);
});

test('AI Center delegated listeners bind after DOM readiness and are idempotent', () => {
  assert.match(html, /document\\.addEventListener\\('DOMContentLoaded',\\s*bindAnasAiCenterActions/);
  assert.match(html, /document\\.addEventListener\\('click',[\\s\\S]*?true\\);/);
  assert.match(html, /document\\.addEventListener\\('change',[\\s\\S]*?true\\);/);
  assert.match(html, /dataset\\.anasAiActionsBound\\s*===\\s*'1'/);
});

test('ChatGPT helper opens, closes, sends and has an offline local fallback', () => {
  assert.match(html, /fab\\.addEventListener\\('click',\\s*openPanel\\)/);
  assert.match(html, /close\\.addEventListener\\('click',\\s*closePanel\\)/);
  assert.match(html, /send\\.addEventListener\\('click',\\s*async function/);
  assert.match(html, /!url\\s*\\|\\|\\s*!navigator\\.onLine/);
  assert.match(html, /وضع محلي — تعذر الاتصال بالخادم/);
});

test('AI Center mobile layout avoids stacked sticky headers and reserves FAB space', () => {
  assert.match(css, /\\.sub-header-bar\\s*\\{[^}]*position:\\s*relative\\s*!important/s);
  assert.match(css, /#view-ai-excel-hub\\s*\\{[^}]*padding-bottom:\\s*calc\\(104px/s);
  assert.match(css, /#anasContextAiFab\\s*\\{[^}]*z-index:\\s*80\\s*!important/s);
  assert.match(css, /#anasContextAiPanel\\s*\\{[^}]*z-index:\\s*81\\s*!important/s);
});

test('ERP script and stylesheet references are relative for the /erp/ deployment path', () => {
  const rootRelativeAssets = [...html.matchAll(/<(?:script|link)\\b[^>]*(?:src|href)=["'](\\/[^"']*)["']/gi)];
  assert.deepEqual(rootRelativeAssets.map(match => match[1]), [],
    'Found root-relative assets that can break below /erp/: ' + rootRelativeAssets.map(match => match[1]).join(', '));
});
