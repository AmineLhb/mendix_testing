#!/usr/bin/env node
/**
 * Warns about missing env vars before they turn into a cryptic test
 * failure — not a hard gate (a role legitimately has no credentials yet
 * until someone fills them in, that's a normal in-progress state, not a
 * bug), just visibility. Two things it checks:
 *
 *  - The repo root .env has GROQ_API_KEY (needed by enrich/explore/the
 *    UI's record button).
 *  - Each project's .env actually defines BASE_URL plus a credential pair
 *    for every role in that project's roles.json — derived from
 *    scripts/roles.js's naming convention, not a separate hand-maintained
 *    list, so this can't drift from what enrich.js itself expects.
 *
 * Usage: node scripts/validate-env.js   (or: npm run validate:env)
 * Always exits 0 — this is an informational report, not a CI gate.
 */
import fs from 'node:fs';
import { listProjects, projectPaths, readProjectRoles } from './project.js';
import { resolveRole } from './roles.js';

function parseEnvKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const text = fs.readFileSync(filePath, 'utf-8');
  const keys = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    keys.add(trimmed.slice(0, eq).trim());
  }
  return keys;
}

let warnings = 0;

// Root .env — tool-level.
const rootKeys = parseEnvKeys('.env');
if (!fs.existsSync('.env')) {
  console.warn('⚠ No .env at the repo root (needed for GROQ_API_KEY). Copy .env.example to .env and fill it in.');
  warnings++;
} else if (!rootKeys.has('GROQ_API_KEY')) {
  console.warn('⚠ Repo root .env is missing GROQ_API_KEY — enrich/explore/the UI\'s record button will fail without it.');
  warnings++;
}

// Per-project .env — app-level.
const projects = listProjects();
if (projects.length === 0) {
  console.log('No projects under projects/ yet — nothing else to check.');
} else {
  for (const name of projects) {
    const { env } = projectPaths(name);
    const keys = parseEnvKeys(env);

    if (!fs.existsSync(env)) {
      console.warn(`⚠ [${name}] No .env file (expected at ${env}).`);
      warnings++;
      continue;
    }

    if (!keys.has('BASE_URL')) {
      console.warn(`⚠ [${name}] .env is missing BASE_URL.`);
      warnings++;
    }

    for (const role of readProjectRoles(name)) {
      let usernameVar, passwordVar;
      try {
        ({ usernameVar, passwordVar } = resolveRole(role));
      } catch (err) {
        console.warn(`⚠ [${name}] role "${role}" in roles.json: ${err.message}`);
        warnings++;
        continue;
      }
      const missing = [usernameVar, passwordVar].filter((v) => !keys.has(v));
      if (missing.length) {
        console.warn(`⚠ [${name}] role "${role}" — .env is missing: ${missing.join(', ')}`);
        warnings++;
      }
    }
  }
}

if (warnings === 0) {
  console.log('✓ No missing env vars found.');
} else {
  console.log(`\n${warnings} warning(s) above — fill in the missing vars before recording/running tests for that role.`);
}
