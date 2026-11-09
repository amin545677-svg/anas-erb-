#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import vm from 'node:vm';

/**
 * Read-only HTML/DOM integrity audit.
 * It intentionally reports only provable static defects (duplicate/empty IDs and
 * malformed classic inline scripts). Dynamically-created DOM nodes are not
 * misclassified as missing static markup.
 */
export function auditHtmlDom(source) {
  const errors = [];
  const ids = new Map();
  const withoutComments = source.replace(/<!--[\\s\\S]*?-->/g, '');
  const markupOnly = withoutComments
    .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script\\s*>/gi, '')
    .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>/gi, '');

  for (const tagMatch of markupOnly.matchAll(/<([a-z][\\w:-]*)\\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const offset = tagMatch.index ?? 0;
    const idMatch = tag.match(/\\bid\\s*=\\s*(["'])(.*?)\\1/i);
    if (!idMatch) continue;
    const id = idMatch[2].trim();
    if (!id) {
      errors.push({ code: 'EMPTY_ID', offset, tag: tagMatch[1] });
      continue;
    }
    const previous = ids.get(id);
    if (previous !== undefined) {
      errors.push({ code: 'DUPLICATE_ID', id, firstOffset: previous, duplicateOffset: offset });
    } else {
      ids.set(id, offset);
    }
  }

  for (const scriptMatch of withoutComments.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script\\s*>/gi)) {
    const attrs = scriptMatch[1] || '';
    const body = scriptMatch[2] || '';
    if (/\\bsrc\\s*=/.test(attrs) || /\\btype\\s*=\\s*(["'])module\\1/i.test(attrs) || !body.trim()) continue;
    try {
      new vm.Script(body, { filename: 'index.html:inline-script' });
    } catch (error) {
      errors.push({
        code: 'INLINE_SCRIPT_SYNTAX',
        message: error.message,
        offset: (scriptMatch.index ?? 0) + scriptMatch[0].indexOf(body)
      });
    }
  }

  return {
    ok: errors.length === 0,
    staticIds: ids.size,
    duplicateIds: errors.filter(item => item.code === 'DUPLICATE_ID').length,
    emptyIds: errors.filter(item => item.code === 'EMPTY_ID').length,
    inlineScriptSyntaxErrors: errors.filter(item => item.code === 'INLINE_SCRIPT_SYNTAX').length,
    errors
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const htmlPath = process.argv[2] || 'index.html';
  if (!fs.existsSync(htmlPath)) {
    console.error('QA DOM audit cannot find HTML entrypoint: ' + htmlPath);
    process.exit(2);
  }
  const report = auditHtmlDom(fs.readFileSync(htmlPath, 'utf8'));
  console.log(JSON.stringify({ audit: 'DOM_INTEGRITY', file: htmlPath, ...report }, null, 2));
  if (!report.ok) process.exit(1);
}
