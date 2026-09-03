#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'generated-tests');
if (!fs.existsSync(dir)) {
  console.error('No generated-tests/ directory found — skipping validation.');
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const emailRe = /["'`]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["'`]/g;
const passwordHints = /(password|pwd|pass|MENDIX_TEST_PASSWORD)/i;

let problems = [];
for (const f of files) {
  const full = path.join(dir, f);
  const txt = fs.readFileSync(full, 'utf8');
  const emails = Array.from(txt.matchAll(emailRe), (m) => m[1]);
  if (emails.length) problems.push({ file: full, reason: 'hardcoded emails', details: emails });
  // look for suspicious literal strings that look like passwords
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (passwordHints.test(l) && /["'`][^"'`]{4,}["'`]/.test(l)) {
      problems.push({ file: full, reason: 'possible hardcoded password', line: i + 1, snippet: l.trim() });
      break;
    }
  }
}

if (problems.length) {
  console.error('Validation failed: found issues in generated tests:');
  for (const p of problems) {
    console.error('-', p.file, p.reason, p.details ? p.details : p.line ? `line ${p.line}` : '');
  }
  process.exit(2);
}

console.log('Generated-tests validation passed.');
