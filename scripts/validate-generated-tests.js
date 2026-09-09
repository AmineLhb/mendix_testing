#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_ROOT, listProjects } from './project.js';

const projects = listProjects();
if (projects.length === 0) {
  console.error(`No projects found under ${PROJECTS_ROOT}/ — skipping validation.`);
  process.exit(0);
}

// Tests live under role subfolders (generated-tests/<role>/*.spec.js), so walk
// recursively instead of a flat readdirSync — a flat read would silently find
// zero .js files (just role directory names) and validation would pass
// without ever having checked anything.
function collectJsFiles(startDir) {
  if (!fs.existsSync(startDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

// Validates every project's generated-tests/, not just whichever one is
// "active" — this is a repo-wide secret-leak check, not a per-project one.
const files = projects.flatMap((p) => collectJsFiles(path.join(PROJECTS_ROOT, p, 'generated-tests')));
const emailRe = /["'`]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["'`]/g;
// Anchored to a password-ish identifier immediately followed by an assignment
// or a .fill(/.type( call, with the literal right there — NOT just "password"
// and any quoted string anywhere on the line. The looser version flagged
// false positives like `basePage.mx('textBox2').fill(process.env.MENDIX_TEST_PASSWORD ?? '')`
// (the widget-name literal earlier in the line has nothing to do with the
// actual password, which correctly comes from process.env) and
// `const passwordField = basePage.mx('textBox2');` (a variable name, not a value).
const passwordLiteralRe = /(password|pwd|passwd)\w*\s*(=|:|\.fill\(|\.type\()\s*["'`][^"'`]{2,}["'`]/i;

let problems = [];
for (const full of files) {
  const txt = fs.readFileSync(full, 'utf8');
  const emails = Array.from(txt.matchAll(emailRe), (m) => m[1]);
  if (emails.length) problems.push({ file: full, reason: 'hardcoded emails', details: emails });
  // look for suspicious literal strings that look like hardcoded passwords
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (passwordLiteralRe.test(l)) {
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

console.log(`Generated-tests validation passed (${files.length} file(s) checked).`);
