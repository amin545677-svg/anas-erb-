import test from 'node:test';
import assert from 'node:assert/strict';
import { auditHtmlDom } from '../scripts/qa-dom-integrity.mjs';

test('DOM audit accepts unique static IDs and valid inline JavaScript', () => {
  const report = auditHtmlDom('<main id="app"></main><script>function openPanel(){ return true; }</script>');
  assert.equal(report.ok, true);
  assert.equal(report.staticIds, 1);
  assert.deepEqual(report.errors, []);
});

test('DOM audit detects duplicate IDs with actionable locations', () => {
  const report = auditHtmlDom('<div id="target"></div><section id="target"></section>');
  assert.equal(report.ok, false);
  assert.equal(report.duplicateIds, 1);
  assert.equal(report.errors[0].code, 'DUPLICATE_ID');
  assert.equal(report.errors[0].id, 'target');
  assert.ok(report.errors[0].duplicateOffset > report.errors[0].firstOffset);
});

test('DOM audit detects empty IDs but ignores comments and script text', () => {
  const report = auditHtmlDom('<!-- <div id="fake"></div> --><div id=""></div><script>const sample = \'<div id="fake"></div>\';</script>');
  assert.equal(report.emptyIds, 1);
  assert.equal(report.staticIds, 0);
  assert.equal(report.duplicateIds, 0);
});

test('DOM audit detects malformed classic inline scripts', () => {
  const report = auditHtmlDom('<script>function broken( {</script>');
  assert.equal(report.ok, false);
  assert.equal(report.inlineScriptSyntaxErrors, 1);
  assert.equal(report.errors[0].code, 'INLINE_SCRIPT_SYNTAX');
});

test('DOM audit leaves external and module scripts to their dedicated toolchains', () => {
  const report = auditHtmlDom('<script src="app.js"></script><script type="module">import x from "./x.js";</script>');
  assert.equal(report.ok, true);
  assert.equal(report.inlineScriptSyntaxErrors, 0);
});
