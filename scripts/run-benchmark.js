#!/usr/bin/env node
/**
 * Benchmark runner skeleton — walks evaluation/, scores whatever cases are
 * actually populated there, and prints an honest result. Deliberately does
 * NOT print a fabricated pass rate when the dataset is empty (today):
 * "0/0 cases" is the correct, truthful output for a dataset that hasn't
 * been populated yet, not a percentage that looks like a real measurement.
 *
 * Release rule (once this has real cases — see evaluation/README.md):
 * a new AI prompt/model must not ship if the overall score drops more than
 * 2 percentage points versus the last recorded baseline, or if any single
 * category drops below its required threshold. Not enforced yet — there's
 * no baseline to compare against until the dataset has cases in it.
 */
import fs from 'node:fs';
import path from 'node:path';

const EVAL_ROOT = 'evaluation';
const CATEGORIES = [
  'recordings',
  'expected-tests',
  'expected-locators',
  'expected-assertions',
  'expected-bdd',
  'failure-cases',
  'healing-cases',
];

function countCases(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (e.isFile() && e.name !== '.gitkeep')).length;
}

function main() {
  console.log('Benchmark run —', new Date().toISOString());
  console.log('');

  let total = 0;
  for (const category of CATEGORIES) {
    const count = countCases(path.join(EVAL_ROOT, category));
    total += count;
    console.log(`  ${category.padEnd(20)} ${count} case(s)`);
  }

  console.log('');
  if (total === 0) {
    console.log('No cases in dataset yet — nothing to score. See evaluation/README.md for how to add the first one.');
    console.log('(This is the correct, honest result for an empty dataset — not a placeholder pass rate.)');
    process.exit(0);
  }

  // Intentionally unimplemented until real cases exist to define the actual
  // scoring shape against (see evaluation/README.md's "Populating a case").
  console.log(`${total} case(s) found, but scoring logic isn't implemented yet — add it once the first real case defines what "correct" looks like for that category.`);
  process.exit(1);
}

main();
