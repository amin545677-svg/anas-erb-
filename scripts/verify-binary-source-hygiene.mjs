#!/usr/bin/env node
'use strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean)
  .filter(file => /\.(?:js|mjs|json|yml)$/i.test(file));
const failures = [];
function escapedNewlineOutsideLiteral(source, file) {
  let quote = null, lineComment = false, blockComment = false, yamlComment = false, regexLiteral = false, inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (regexLiteral) {
      if (c === '\\\\') { i++; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) regexLiteral = false;
      continue;
    }
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (yamlComment) { if (c === '\n') yamlComment = false; continue; }
    if (!file.endsWith('.yml') && c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (!file.endsWith('.yml') && c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (file.endsWith('.yml') && c === '#') { yamlComment = true; continue; }
    if (!file.endsWith('.yml') && c === '/') {
      const prefix = source.slice(0, i).trimEnd();
      const regexMayStart = /(?:^|[=(:,!{;?&|+*%~<>-]|=>|\\b(?:return|throw|case|typeof|void|delete|instanceof|in|of|yield|await))$/.test(prefix);
      if (regexMayStart) { regexLiteral = true; inClass = false; continue; }
    }
    if (c === '"' || c === "'" || (!file.endsWith('.yml') && c === '`')) { quote = c; continue; }
    if (c === '\\' && n === 'n' && source[i - 1] !== '\\') return i;
  }
  return -1;
}
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    failures.push(file + ': UTF-8 BOM (EF BB BF)');
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) { failures.push(file + ': CRLF at byte ' + i); break; }
  }
  const source = bytes.toString('utf8');
  if (source.includes('\uFFFD')) failures.push(file + ': invalid UTF-8 replacement character');
  if (/\.(?:mjs|yml)$/i.test(file)) {
    const offset = escapedNewlineOutsideLiteral(source, file);
    if (offset >= 0) failures.push(file + ': escaped newline outside quoted literal at character ' + offset);
  }
  try {
    if (/\.json$/i.test(file)) JSON.parse(source);
    else if (/\.(?:js|mjs)$/i.test(file)) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  } catch (error) {
    failures.push(file + ': syntax validation failed: ' + String(error.stderr || error.message).slice(0, 500));
  }
}
if (failures.length) {
  console.error('BINARY SOURCE HYGIENE FAILED (' + failures.length + '):\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ audit: 'PASS', filesChecked: files.length, bom: 0, crlf: 0, escapedNewlinesOutsideLiterals: 0, syntaxErrors: 0 }));
}
