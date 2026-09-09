#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_ROOT, listProjects } from './project.js';
import { checkTextForSecrets } from './check-secrets.js';

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

let problems = [];
for (const full of files) {
  const txt = fs.readFileSync(full, 'utf8');
  for (const problem of checkTextForSecrets(txt)) {
    problems.push({ file: full, ...problem });
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
