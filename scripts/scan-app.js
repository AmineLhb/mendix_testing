#!/usr/bin/env node
/**
 * Mendix App Scanner (v1) — logs in as one role, then does a best-effort,
 * SINGLE-session breadth-first exploration of same-page navigation-like
 * widgets, snapshotting the real mx-name-* widgets present on every distinct
 * page it finds. Grounded the same way everything else in this project is:
 * only what's actually clicked and actually rendered, never a guess at
 * pages/widgets that might exist.
 *
 * Deliberately ONE login for the whole scan, not one per page visited — this
 * project already treats login volume as a real cost against the trial
 * Mendix license's concurrent-session cap (see README's "Known issue"
 * section), and a scanner that logged in per candidate widget would directly
 * work against that. The tradeoff: returning to the nav after a click relies
 * on the browser's real back-navigation (page.goBack()) actually working,
 * which depends on how a given Mendix app's client routing behaves — if it
 * doesn't, the crawl notices (the nav it started from is gone) and stops
 * early rather than pretending to keep discovering pages honestly.
 *
 * NOT a Studio Pro project scanner — this tool has no access to a Mendix app's
 * source project, so it can't enumerate microflows/entities/permissions the
 * way a real IDE-level scanner could. It only sees what a real browser
 * session sees, the same ground truth every other feature here is built on.
 *
 * Usage: node scripts/scan-app.js <role> [--project <name>] [--max-pages N]
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectEnv, projectPaths, projectExists, readProjectRoles } from './project.js';
import { resolveRole } from './roles.js';
import { BasePage } from '../pages/BasePage.js';
import { submitLogin } from '../steps/business-steps.js';

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf('--project');
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const maxPagesIdx = argv.indexOf('--max-pages');
const maxPages = maxPagesIdx > -1 ? Math.max(1, Math.min(50, Number(argv[maxPagesIdx + 1]) || 15)) : 15;
if (maxPagesIdx > -1) argv.splice(maxPagesIdx, 2);

const [role] = argv;
if (!role) {
  console.error('Usage: node scripts/scan-app.js <role> [--project <name>] [--max-pages N]');
  process.exit(1);
}

if (!projectExists(projectName)) {
  const paths = projectPaths(projectName);
  console.error(`Project "${paths.name}" doesn't exist (looked for ${paths.root}).`);
  process.exit(1);
}
await loadProjectEnv(projectName);
const paths = projectPaths(projectName);

if (!readProjectRoles(projectName).includes(role)) {
  console.error(`Unknown role "${role}" for project "${paths.name}".`);
  process.exit(1);
}

const { usernameVar, passwordVar } = resolveRole(role);
const username = process.env[usernameVar];
const password = process.env[passwordVar];
if (!username || !password) {
  console.error(`Missing credentials — set ${usernameVar}/${passwordVar} in ${paths.env}.`);
  process.exit(1);
}

const baseUrl = process.env.BASE_URL;
if (!baseUrl) {
  console.error(`BASE_URL not set in ${paths.env}.`);
  process.exit(1);
}

const snapshotWidgets = (page) =>
  page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="mx-name-"]'));
    return els.slice(0, 300).map((el) => ({
      tag: el.tagName.toLowerCase(),
      mxNames: (el.className.match(/mx-name-\S+/g) || []).map((n) => n.replace(/^mx-name-/, '')),
      text: (el.textContent || '').trim().slice(0, 50),
    }));
  });

// Candidates for "this might navigate somewhere": a real <a> tag, or
// anything Mendix marks with role=menuitem/button and a pointer cursor —
// generic heuristics, not app-specific knowledge, since nothing about this
// app's actual navigation structure has been inspected ahead of time.
const findNavCandidates = (page) =>
  page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="mx-name-"]'));
    return els
      .filter((el) => {
        const style = window.getComputedStyle(el);
        const isLink = el.tagName === 'A';
        const looksClickable = style.cursor === 'pointer' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'button';
        return isLink || looksClickable;
      })
      .map((el) => (el.className.match(/mx-name-\S+/) || [])[0])
      .filter(Boolean)
      .map((c) => c.replace(/^mx-name-/, ''))
      .filter((name, i, arr) => arr.indexOf(name) === i)
      .slice(0, 40);
  });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const basePage = new BasePage(page);

  console.log(`Logging in as "${role}"...`);
  await page.goto(baseUrl);
  const { status, body } = await submitLogin(basePage, { username, password });
  basePage.expectApiSuccess({ status, body });
  await basePage.waitForMendixIdle();
  console.log('Logged in. Starting crawl.');

  const pages = [];
  const visitedKeys = new Set();
  const recordPage = async (label) => {
    const widgets = await snapshotWidgets(page);
    const key = `${page.url()}|${widgets.length}`;
    if (visitedKeys.has(key)) return false;
    visitedKeys.add(key);
    pages.push({ label, url: page.url(), widgets });
    return true;
  };

  await recordPage('landing page');
  const navCandidates = await findNavCandidates(page);
  console.log(`Found ${navCandidates.length} navigation-like widget(s) on the landing page.`);

  let stoppedEarly = null;
  for (const widgetName of navCandidates) {
    if (pages.length >= maxPages) break;
    try {
      const stillThere = await basePage.mx(widgetName).first().isVisible().catch(() => false);
      if (!stillThere) continue; // page changed under us (a previous click's goBack didn't fully restore state) — skip, don't guess
      await basePage.mx(widgetName).first().click({ timeout: 5000 });
      await basePage.waitForMendixIdle();
      await recordPage(widgetName);

      await page.goBack({ timeout: 8000 }).catch(() => {});
      await basePage.waitForMendixIdle();
      const backOnLanding = await basePage.mx(navCandidates[0]).first().isVisible().catch(() => false);
      if (!backOnLanding) {
        stoppedEarly = `Stopped after "${widgetName}" — back-navigation didn't return to the starting nav (this app's client routing may not support it), so continuing would mean guessing at page state instead of observing it.`;
        break;
      }
    } catch (err) {
      // One candidate failing (e.g. it was actually a non-navigating button)
      // isn't fatal to the whole scan — note it and move to the next one.
      console.log(`  (skipped "${widgetName}": ${err.message.split('\n')[0]})`);
    }
  }

  await basePage.logout().catch(() => {});
  await browser.close();

  const uniqueWidgets = new Set();
  for (const p of pages) for (const w of p.widgets) uniqueWidgets.add(w.mxNames.join(','));

  const result = {
    role,
    scannedAt: Date.now(),
    maxPages,
    baseUrl,
    pages,
    summary: { pageCount: pages.length, uniqueWidgetCount: uniqueWidgets.size },
    stoppedEarly,
  };

  const outDir = path.join(paths.explorer, 'app-scan');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${role}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`\nScan complete: ${pages.length} page(s), ${uniqueWidgets.size} unique widget(s).`);
  if (stoppedEarly) console.log(stoppedEarly);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
