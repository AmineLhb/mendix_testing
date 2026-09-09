#!/usr/bin/env node
// Regenerates every project's generated-tests/**/*.feature doc from its
// matching .spec.js file's current test.step() labels. Run this after
// hand-editing a spec's steps directly; enrich.js already does this
// automatically for newly generated tests, so you shouldn't normally need it
// for those. Covers every project under projects/, not just the active one.
import fs from 'node:fs';
import path from 'node:path';
import { deriveFeatureText, featurePathFor } from './gherkin.js';
import { PROJECTS_ROOT, listProjects } from './project.js';

const projects = listProjects();
if (projects.length === 0) {
  console.error(`No projects found under ${PROJECTS_ROOT}/.`);
  process.exit(1);
}

function collectSpecFiles(startDir) {
  if (!fs.existsSync(startDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) files.push(...collectSpecFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.spec.js')) files.push(full);
  }
  return files;
}

const specFiles = projects.flatMap((p) => collectSpecFiles(path.join(PROJECTS_ROOT, p, 'generated-tests')));
let written = 0;
let skipped = 0;

for (const specPath of specFiles) {
  const specText = fs.readFileSync(specPath, 'utf8');
  const fallbackTitle = path.basename(specPath, '.spec.js');
  const featureText = deriveFeatureText(specText, fallbackTitle);
  if (!featureText) {
    console.log(`- ${specPath}: no test.step() calls found, skipping`);
    skipped++;
    continue;
  }
  const featurePath = featurePathFor(specPath);
  fs.writeFileSync(featurePath, featureText);
  console.log(`+ ${featurePath}`);
  written++;
}

console.log(`\nDone. ${written} .feature file(s) written, ${skipped} spec(s) skipped (no steps).`);
