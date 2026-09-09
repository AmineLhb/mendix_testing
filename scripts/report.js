#!/usr/bin/env node
// Opens the active project's most recent HTML report (playwright.config.js
// writes it to projects/<name>/playwright-report/ — see scripts/project.js).
// Set MENDIX_PROJECT to open a different project's report.
import { spawn } from 'node:child_process';
import { projectPaths } from './project.js';

const { playwrightReport } = projectPaths();
const child = spawn('npx', ['playwright', 'show-report', playwrightReport], {
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
