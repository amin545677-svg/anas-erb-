#!/usr/bin/env node
'use strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean)
  .filter(file => /\.(?:js|mjs|json|yml)$/i.test(file));
const failures = [];
function suspiciousEscapedNewline(source, file) {
  // Detect a literal \n token used at the start of a physical source line
  // before a command/declaration. Valid escapes inside strings and regexes
  // are deliberately excluded to avoid parser-free false positives.
  const command = file.endsWith('.yml')
    ? /^(?:node|npm|yarn|git|run:|-)\b/
    : /^(?:import|export|const|let|var|function|async|if|return|throw)\b/;
  return source.split(/\r?\n/).some(line => /^\\n[ \t]*/.test(line) && command.test(line.replace(/^\\n[ \t]*/, '')));
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
  if (/\\.(?:js|mjs|yml)$/i.test(file) && suspiciousEscapedNewline(source, file)) {
    failures.push(file + ': suspicious literal \\\\n used as a physical source separator');
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
