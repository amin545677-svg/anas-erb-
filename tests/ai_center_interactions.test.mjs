import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../anas-erp-ui-safe-enhancements.css', import.meta.url), 'utf8');

function hasFunction(name) {
  return html.includes('function ' + name + '(');
}

test('AI Center actions resolve to implemented handlers and delegated actions', () => {
  for (const name of [
    'renderAiHub', 'switchAiTab', 'anasSetAiPrompt', 'triggerAiGeneration',
    'handleSmartAiUpload', 'openInvoiceOcr', 'askAnasBusinessAI',
    'anasNormalizeAiGatewayUrl', 'anasDownloadPdfText', 'anasAskAiAboutPdf'
  ]) assert.ok(hasFunction(name), 'Missing AI Center handler: ' + name);
  for (const action of ['ask', 'generate', 'import', 'ocr'])
    assert.ok(html.includes('data-anas-ai-action="' + action + '"'), 'Missing delegated action: ' + action);
  assert.ok(html.includes('id="smartAiExcelUpload"'));
  assert.ok(html.includes("document.addEventListener('DOMContentLoaded', bindAnasAiCenterActions"));
  assert.ok(html.includes("document.addEventListener('click', function (event)"));
  assert.ok(html.includes("document.addEventListener('change', function (event)"));
});

test('contextual ChatGPT helper binds open, close and send actions', () => {
  assert.ok(html.includes("fab.addEventListener('click',openPanel)"));
  assert.ok(html.includes("close.addEventListener('click',closePanel)"));
  assert.ok(html.includes("send.addEventListener('click',async function"));
});

test('AI Center mobile layout avoids stacked sticky headers and reserves FAB space', () => {
  assert.ok(css.includes('position: relative !important;'));
  assert.ok(css.includes('padding-bottom: calc(104px + env(safe-area-inset-bottom))'));
  assert.ok(css.includes('#anasContextAiFab'));
  assert.ok(css.includes('#anasContextAiPanel'));
});

test('ERP script and stylesheet references are not root-relative', () => {
  const tags = html.match(/<(?:script|link)\\b[^>]*>/gi) || [];
  const rootRelative = tags.flatMap(tag => [...tag.matchAll(/(?:src|href)=["'](\\/[^"']*)["']/gi)].map(m => m[1]));
  assert.deepEqual(rootRelative, [], 'Root-relative assets break the /erp/ deployment path: ' + rootRelative.join(', '));
});
