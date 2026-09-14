#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadProjectEnv, projectPaths, projectExists, readProjectRoles, writePending } from './project.js';
import { scoreTestQuality } from './confidence.js';
import { runSpecUpToLogout } from './replay-widgets.js';
import { deriveFeatureText } from './gherkin.js';

// Usage: node scripts/record-and-enrich.js <role> <flow-name> [app-url] [--project <name>] [--save-storage <path>] [--force] [--stage] [--update] [--extend]
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
//
// --update marks this recording as replacing an EXISTING test (the UI's
// "Update (re-record)" mode and Test Explorer's Edit button) rather than
// creating a new one — the only difference is what the pending proposal
// diffs against: the OLD generated-tests content (so the reviewer sees old
// test code vs new test code) instead of the raw recording. Re-recording
// also naturally overwrites raw-<role>-<flow>.spec.js either way, which is
// what repairs a test whose raw recording had gone missing (heal.js's own
// hard requirement) — no separate step needed for that.
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node scripts/record-and-enrich.js <role> <flow-name> [app-url] [--project <name>] [--save-storage <path>] [--force] [--stage] [--update] [--extend]');
  console.error('app-url defaults to BASE_URL from the active project\'s .env if omitted.');
  process.exit(1);
}

const forceIdx = argv.indexOf('--force');
if (forceIdx > -1) argv.splice(forceIdx, 1);
const force = forceIdx > -1;

const stageIdx = argv.indexOf('--stage');
if (stageIdx > -1) argv.splice(stageIdx, 1);
const stage = stageIdx > -1;

const updateIdx = argv.indexOf('--update');
if (updateIdx > -1) argv.splice(updateIdx, 1);
const isUpdate = updateIdx > -1;

// --extend: "continue" mode — records only the NEW tail of a scenario that's
// grown bigger, starting from a live storageState snapshot captured by
// actually running the EXISTING test's own steps (stopping right before its
// closing logout step), so the human doesn't re-click through login and
// every earlier step by hand. Always stages (never writes generated-tests/
// directly, regardless of whether --stage was also passed) since the merge
// step is a deterministic text splice into an already-passing file — that
// always needs a human's review, the same trust bar as everything else this
// project proposes automatically. See runExtendFlow() below.
const extendIdx = argv.indexOf('--extend');
if (extendIdx > -1) argv.splice(extendIdx, 1);
const isExtend = extendIdx > -1;
if (isExtend && isUpdate) {
  console.error('--extend and --update are mutually exclusive — extend continues an existing test, update replaces it from scratch.');
  process.exit(1);
}

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
const rawPath = isExtend
  ? path.join(paths.explorer, `raw-${role}-${flowName}-tail.spec.js`) // separate from the main raw recording — this is only the NEW tail
  : path.join(paths.explorer, `raw-${role}-${flowName}.spec.js`);
const pendingId = `${role}-${flowName}`;
const outPath = stage || isExtend
  ? path.join(paths.explorer, 'pending', pendingId, isExtend ? 'extend-fragment.js' : 'spec.js')
  : path.join(paths.generatedTests, role, `${flowName}.spec.js`);
const existingSpecPath = path.join(paths.generatedTests, role, `${flowName}.spec.js`);
const storageStatePath = path.join(paths.explorer, `extend-storage-${role}-${flowName}.json`);

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
  // Default to the real, installed Chrome rather than Playwright's bundled
  // Chromium — Google's "This browser or app may not be secure" block on
  // Google sign-in specifically targets automation-flavored/embedded
  // browsers, and the bundled Chromium build trips it far more often than
  // an actual Chrome install does. Only added when the caller hasn't
  // already picked a channel/browser themselves.
  const hasBrowserChoice = extraArgs.some((a) => a.startsWith('--channel') || a.startsWith('--browser'));
  const args = [
    'playwright',
    'codegen',
    appUrl,
    '--output',
    rawPath,
    ...(hasBrowserChoice ? [] : ['--channel', 'chrome']),
    ...(isExtend ? ['--load-storage', storageStatePath] : []),
    ...extraArgs,
  ];
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
    [
      'explorer/enrich.js',
      rawPath,
      appUrl,
      outPath,
      '--role',
      role,
      '--project',
      paths.name,
      ...(isExtend ? ['--extend-steps-only'] : []),
    ],
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

// Same convention runSpecUpToLogout uses to find where to STOP replaying —
// reused here to find where to STOP the existing file's text and splice the
// new fragment in, right before that same step. Kept as one shared pattern
// so the two can't silently drift out of sync with each other.
const LOGOUT_STEP_RE = /([ \t]*)await test\.step\(\s*(['"`])(?:(?!\2).)*log\s*s?\s*out(?:(?!\2).)*\2/i;

/** Deterministically (no AI involved in this part) splices a new step
 * fragment into an existing spec's text, right before its closing logout
 * step — reindented to match. Never asked the model to reproduce the whole
 * file, so there's no way for this step to introduce an unrelated change
 * anywhere else in an already-passing test. Throws if the existing file
 * doesn't have a matching logout step to anchor on, rather than guessing
 * where else it might be safe to insert. */
function spliceExtendFragment(existingText, fragmentText) {
  const match = LOGOUT_STEP_RE.exec(existingText);
  if (!match) {
    throw new Error(
      `Couldn't find a closing "...log out..." test.step() in the existing spec to insert the new steps before — Extend only supports a scenario that ends with one (the convention enrich.js's own prompt always follows). Add the new step(s) by hand instead, or use Update to re-record the whole flow.`
    );
  }
  const baseIndent = match[1];
  // Strip only leading/trailing BLANK lines, not whitespace — a plain
  // .trim() on the whole string instead would strip line 0's own leading
  // indentation (since it's the start of the string) while every other
  // line keeps theirs, corrupting the common-indent measurement below for
  // every line after the first. Verified this was a real bug: an earlier
  // version using .trim() produced visibly wrong (too-deep, inconsistent)
  // indentation in the spliced result.
  const fragmentLines = fragmentText.split('\n');
  while (fragmentLines.length && fragmentLines[0].trim() === '') fragmentLines.shift();
  while (fragmentLines.length && fragmentLines[fragmentLines.length - 1].trim() === '') fragmentLines.pop();
  const nonEmptyLines = fragmentLines.filter((l) => l.trim() !== '');
  const commonIndent = nonEmptyLines.length
    ? Math.min(...nonEmptyLines.map((l) => l.match(/^[ \t]*/)[0].length))
    : 0;
  const reindented = fragmentLines
    .map((l) => (l.trim() === '' ? '' : baseIndent + l.slice(commonIndent)))
    .join('\n');

  // match.index sits right at the start of the logout step's own leading
  // indentation (LOGOUT_STEP_RE's first capture group), so everything from
  // there onward — indent included — can stay completely untouched; the
  // fragment (already reindented to baseIndent per line above) is just
  // inserted right before it, followed by a blank line to match this
  // project's existing between-steps spacing convention.
  const insertAt = match.index;
  return `${existingText.slice(0, insertAt)}${reindented}\n\n${existingText.slice(insertAt)}`;
}

async function runExtendFlow() {
  if (!fs.existsSync(existingSpecPath)) {
    console.error(`No existing test at ${existingSpecPath} — Extend continues an already-recorded scenario. Record it first (without --extend), then extend it once it's grown.`);
    process.exit(1);
  }
  const existingSpecText = fs.readFileSync(existingSpecPath, 'utf-8');

  console.log(`Running ${role}/${flowName}.spec.js's own steps against the app to capture a logged-in starting point for the new steps...`);
  let capture;
  try {
    capture = await runSpecUpToLogout(existingSpecText, { baseUrl: appUrl, specPath: existingSpecPath });
  } catch (err) {
    console.error(`Can't extend — replaying the existing test's own steps failed: ${err.message}`);
    console.error('Fix the existing test first (Update (re-record), or Analyze & heal locators), then try Extend again.');
    process.exit(1);
  }
  if (!capture.stoppedBeforeLogout) {
    console.log(`Note: ${role}/${flowName}.spec.js has no closing "...log out..." step, so its steps ran to the end rather than stopping partway — the recorder will still open logged in wherever that left off.`);
  }

  fs.mkdirSync(paths.explorer, { recursive: true });
  fs.writeFileSync(storageStatePath, JSON.stringify(capture.storageState));

  try {
    await runCodegen();
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Raw recording not found at ${rawPath}`);
    }
    await runEnrich();

    const fragmentText = fs.readFileSync(outPath, 'utf-8');
    const splicedText = spliceExtendFragment(existingSpecText, fragmentText);

    const quality = scoreTestQuality(splicedText);
    console.log(`Test quality score (full scenario after extending): ${quality.overall}% (locators ${quality.breakdown.locatorStability}%, assertions ${quality.breakdown.assertions}%, async ${quality.breakdown.asyncHandling}%, BDD ${quality.breakdown.bddStructure}%, negative-path coverage ${quality.breakdown.negativePathCoverage}%)`);

    const fallbackTitle = flowName;
    const featureText = deriveFeatureText(splicedText, fallbackTitle);

    const dir = writePending(projectName, pendingId, {
      type: 'extend',
      role,
      flowName,
      specText: splicedText,
      featureText: featureText || undefined,
      previousText: existingSpecText,
      quality,
    });
    // The fragment file (extend-fragment.js) served its purpose once spliced
    // — remove it so the pending dir only holds the real spec.js/meta.json
    // shape every other proposal type has.
    fs.rmSync(outPath, { force: true });

    console.log(`Staged for review: ${dir}`);
    console.log('Review the diff in the UI — the new steps are appended right before the existing logout step — and approve it before it becomes a real test.');
  } finally {
    fs.rmSync(storageStatePath, { force: true }); // holds live session cookies — don't leave it lying around once used
  }
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
    if (isExtend) {
      await runExtendFlow();
      return;
    }
    await confirmOverwrite();
    await runCodegen();
    // ensure file exists
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Raw recording not found at ${rawPath}`);
    }
    await runEnrich();

    // Deterministic (no LLM call) — inspects the enriched spec itself for
    // locator stability, assertion coverage, fixed-wait usage, and BDD
    // structure. See scripts/confidence.js.
    const quality = scoreTestQuality(fs.readFileSync(outPath, 'utf-8'));
    console.log(`Test quality score: ${quality.overall}% (locators ${quality.breakdown.locatorStability}%, assertions ${quality.breakdown.assertions}%, async ${quality.breakdown.asyncHandling}%, BDD ${quality.breakdown.bddStructure}%)`);

    if (stage) {
      // For an update, diff against the CURRENT real test content (not the
      // raw recording — readPending falls back to that only when there's no
      // previous.spec.js) so the reviewer sees old test code vs new test
      // code, same as a self-heal "fix" proposal already does.
      const existingTestPath = path.join(paths.generatedTests, role, `${flowName}.spec.js`);
      if (isUpdate && fs.existsSync(existingTestPath)) {
        fs.writeFileSync(
          path.join(paths.explorer, 'pending', pendingId, 'previous.spec.js'),
          fs.readFileSync(existingTestPath, 'utf-8')
        );
      }
      // meta.json alongside the spec.js/spec.feature enrich.js already wrote
      // to the pending dir — writePending() would rewrite spec.js too, so
      // just write the metadata file directly instead of re-deriving it.
      fs.writeFileSync(
        path.join(paths.explorer, 'pending', pendingId, 'meta.json'),
        JSON.stringify({ type: isUpdate ? 'update' : 'new-test', role, flowName, createdAt: Date.now(), quality }, null, 2)
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
