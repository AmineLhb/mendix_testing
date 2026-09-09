#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadProjectEnv, projectPaths, projectExists, readProjectRoles } from './project.js';

// Usage: node scripts/record-and-enrich.js <role> <flow-name> [app-url] [--project <name>] [--save-storage <path>] [--force] [--stage]
//
// app-url defaults to BASE_URL from the active project's .env, and project
// defaults to DEFAULT_PROJECT (scripts/project.js), so day-to-day usage is
// just:
//   npm run new-test -- collaborateur edit-visit
//
// --stage writes the enriched test to projects/<name>/explorer/pending/
// instead of straight to generated-tests/, for review in the UI before it
// becomes a real, running test (validation + the interactive overwrite
// confirmation both happen at approve time instead, since nothing real is
// being touched yet). This is what the UI's Record button uses; the CLI
// default (no --stage) keeps writing directly, unchanged.
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node scripts/record-and-enrich.js <role> <flow-name> [app-url] [--project <name>] [--save-storage <path>] [--force] [--stage]');
  console.error('app-url defaults to BASE_URL from the active project\'s .env if omitted.');
  process.exit(1);
}

const forceIdx = argv.indexOf('--force');
if (forceIdx > -1) argv.splice(forceIdx, 1);
const force = forceIdx > -1;

const stageIdx = argv.indexOf('--stage');
if (stageIdx > -1) argv.splice(stageIdx, 1);
const stage = stageIdx > -1;

const projectIdx = argv.indexOf('--project');
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

if (!projectExists(projectName)) {
  const paths = projectPaths(projectName);
  console.error(`Project "${paths.name}" doesn't exist (looked for ${paths.root}). Create it first (via the UI, or scripts/project.js's createProject()).`);
  process.exit(1);
}
await loadProjectEnv(projectName);
const paths = projectPaths(projectName);

const role = argv[0];
const projectRoles = readProjectRoles(projectName);
if (!projectRoles.includes(role)) {
  console.error(`Unknown role "${role}" for project "${paths.name}".`);
  console.error(
    projectRoles.length
      ? `Known roles: ${projectRoles.join(', ')}`
      : 'This project has no roles defined yet — add one first (via the UI\'s "+ role" control, or scripts/project.js\'s addProjectRole()).'
  );
  process.exit(1);
}

const flowName = argv[1];
// Third positional arg is only an app-url override if it doesn't start with
// "--" (i.e. isn't itself a flag like --save-storage) — lets callers skip it
// entirely and go straight to extra codegen flags.
const hasUrlOverride = argv[2] && !argv[2].startsWith('--');
const appUrl = hasUrlOverride ? argv[2] : process.env.BASE_URL;
const extraArgs = hasUrlOverride ? argv.slice(3) : argv.slice(2);

if (!appUrl) {
  console.error(`No app-url given and BASE_URL is not set in ${paths.env}. Set one or the other.`);
  process.exit(1);
}

// Raw recordings are namespaced by role so the same flow name recorded for
// two different roles (e.g. "validate-visit" for both medecin and infirmier)
// doesn't collide on disk.
const rawPath = path.join(paths.explorer, `raw-${role}-${flowName}.spec.js`);
const pendingId = `${role}-${flowName}`;
const outPath = stage
  ? path.join(paths.explorer, 'pending', pendingId, 'spec.js')
  : path.join(paths.generatedTests, role, `${flowName}.spec.js`);

async function confirmOverwrite() {
  if (stage || force || !fs.existsSync(outPath)) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `${outPath} already exists and will be overwritten once enrich finishes. Continue? (y/N) `
  );
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Aborted — existing test left untouched.');
    process.exit(0);
  }
}

async function runCodegen() {
  console.log(`Starting Playwright recorder for ${appUrl}. Output: ${rawPath}`);
  console.log(`Log in as the "${role}" role when the recorder opens.`);
  fs.mkdirSync(paths.explorer, { recursive: true });
  const args = ['playwright', 'codegen', appUrl, '--output', rawPath, ...extraArgs];
  const child = spawn('npx', args, { stdio: 'inherit', shell: true });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright codegen exited with ${code}`));
    });
    child.on('error', (err) => reject(err));
  });
}

async function runEnrich() {
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY not set (checked the repo root .env). Set it and re-run.');
    process.exit(1);
  }
  console.log(`Replaying and enriching ${rawPath} -> ${outPath} (role: ${role}, project: ${paths.name})`);
  const child = spawn(
    'node',
    ['explorer/enrich.js', rawPath, appUrl, outPath, '--role', role, '--project', paths.name],
    { stdio: 'inherit' }
  );
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('enrich.js failed'));
    });
    child.on('error', (err) => reject(err));
  });
}

async function validate() {
  console.log('Validating generated tests...');
  const child = spawn('node', ['scripts/validate-generated-tests.js'], { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('validation failed'));
    });
    child.on('error', (err) => reject(err));
  });
}

(async () => {
  try {
    await confirmOverwrite();
    await runCodegen();
    // ensure file exists
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Raw recording not found at ${rawPath}`);
    }
    await runEnrich();

    if (stage) {
      // meta.json alongside the spec.js/spec.feature enrich.js already wrote
      // to the pending dir — writePending() would rewrite spec.js too, so
      // just write the metadata file directly instead of re-deriving it.
      fs.writeFileSync(
        path.join(paths.explorer, 'pending', pendingId, 'meta.json'),
        JSON.stringify({ type: 'new-test', role, flowName, createdAt: Date.now() }, null, 2)
      );
      console.log(`Staged for review: projects/${paths.name}/explorer/pending/${pendingId}/`);
      console.log('Review and approve it in the UI before it becomes a real test.');
    } else {
      await validate();
      console.log('Record -> Enrich -> Validate complete. Review generated test at', outPath);
      console.log(`It is picked up automatically next time you run tests for the "${paths.name}" project.`);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
})();
