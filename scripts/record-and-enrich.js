#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Load .env if present so the wrapper can access GROQ_API_KEY set locally
if (fs.existsSync(path.resolve(process.cwd(), '.env'))) {
  await import('dotenv').then((d) => d.config({ path: path.resolve(process.cwd(), '.env') }));
}

// Usage: node scripts/record-and-enrich.js <app-url> <flow-name> [--save-storage explorer/session.auth-state.json]
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node scripts/record-and-enrich.js <app-url> <flow-name> [--save-storage <path>]');
  process.exit(1);
}

const appUrl = argv[0];
const flowName = argv[1];
const extraArgs = argv.slice(2);

const rawPath = path.join('explorer', `raw-${flowName}.spec.js`);
const outPath = path.join('generated-tests', `${flowName}.spec.js`);

async function runCodegen() {
  console.log(`Starting Playwright recorder for ${appUrl}. Output: ${rawPath}`);
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
    console.error('GROQ_API_KEY not set in environment. Set it and re-run.');
    process.exit(1);
  }
  console.log(`Replaying and enriching ${rawPath} -> ${outPath}`);
  const child = spawn('node', ['explorer/enrich.js', rawPath, appUrl, outPath], { stdio: 'inherit' });
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
    await runCodegen();
    // ensure file exists
    if (!fs.existsSync(rawPath)) {
      throw new Error(`Raw recording not found at ${rawPath}`);
    }
    await runEnrich();
    await validate();
    console.log('Record -> Enrich -> Validate complete. Review generated test at', outPath);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
})();
