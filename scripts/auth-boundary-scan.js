#!/usr/bin/env node
/**
 * Cross-role authorization boundary scan — checks whether an action/widget
 * that only ever showed up while logged in as a HIGHER-privilege role is
 * actually present and visible while logged in as a LOWER-privilege role.
 *
 * Why this shape, not "hit the higher role's URL directly as the lower
 * role" (the more familiar web-pentest technique): verified against this
 * project's actual app (explorer/app-scan/*.json, all roles) that every
 * single page the App Scanner records shares the exact same URL
 * (http://localhost:8080/) — this Mendix app is a pure client-side SPA with
 * no per-page routing, so there is no distinct URL to deep-link into and a
 * URL-based bypass probe would be silently meaningless here. What a real
 * browser session CAN tell you honestly is whether a specific mx-name-*
 * widget — the same stable per-widget class every other feature in this
 * project is grounded in — is actually rendered and visible in the DOM for
 * a role that a prior App Scan never found it for.
 *
 * Reuses each role's already-captured `explorer/app-scan/<role>.json`
 * (run `scripts/scan-app.js` first for both roles if missing — this script
 * does not re-scan) rather than re-crawling: the "exclusive to the higher
 * role" widget set is just a set difference over data already collected.
 *
 * Then logs in ONCE as the lower role (same seat-limit discipline as
 * scan-app.js) and, at the landing page plus every page label its own scan
 * already reached, checks each exclusive widget's visibility with a short
 * timeout. A hit is reported as a FINDING, never auto-"fixed" or filed as
 * a test — this is a signal for a human to go verify by hand, same as
 * every other AI/automation output in this project. A widget being visible
 * in the DOM doesn't by itself prove the underlying microflow would
 * actually execute for that role (Mendix typically also enforces access
 * server-side on the microflow/entity itself) — the finding is honest about
 * that: "reachable in the UI," not "confirmed exploitable."
 *
 * Usage:
 *   node scripts/auth-boundary-scan.js <lowerRole> <higherRole> [--project <name>]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { loadProjectEnv, projectPaths, projectExists, readProjectRoles } from "./project.js";
import { resolveRole } from "./roles.js";
import { BasePage } from "../pages/BasePage.js";
import { submitLogin } from "../steps/business-steps.js";

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const [lowerRole, higherRole] = argv;
if (!lowerRole || !higherRole) {
  console.error("Usage: node scripts/auth-boundary-scan.js <lowerRole> <higherRole> [--project <name>]");
  process.exit(1);
}
if (lowerRole === higherRole) {
  console.error("Give two different roles to compare.");
  process.exit(1);
}

if (!projectExists(projectName)) {
  const paths = projectPaths(projectName);
  console.error(`Project "${paths.name}" doesn't exist (looked for ${paths.root}).`);
  process.exit(1);
}
await loadProjectEnv(projectName);
const paths = projectPaths(projectName);

const roles = readProjectRoles(projectName);
for (const r of [lowerRole, higherRole]) {
  if (!roles.includes(r)) {
    console.error(`Unknown role "${r}" for project "${paths.name}".`);
    process.exit(1);
  }
}

const scanPath = (role) => path.join(paths.explorer, "app-scan", `${role}.json`);
for (const r of [lowerRole, higherRole]) {
  if (!fs.existsSync(scanPath(r))) {
    console.error(
      `No App Scan yet for "${r}" — run \`node scripts/scan-app.js ${r} --project ${paths.name}\` first ` +
        `(this script compares two existing scans, it doesn't crawl itself).`
    );
    process.exit(1);
  }
}

const { usernameVar, passwordVar } = resolveRole(lowerRole);
const username = process.env[usernameVar];
const password = process.env[passwordVar];
if (!username || !password) {
  console.error(`Missing credentials for "${lowerRole}" — set ${usernameVar}/${passwordVar} in ${paths.env}.`);
  process.exit(1);
}

const baseUrl = process.env.BASE_URL;
if (!baseUrl) {
  console.error(`BASE_URL not set in ${paths.env}.`);
  process.exit(1);
}

async function main() {
  const lowerScan = JSON.parse(fs.readFileSync(scanPath(lowerRole), "utf-8"));
  const higherScan = JSON.parse(fs.readFileSync(scanPath(higherRole), "utf-8"));

  const lowerWidgets = new Set();
  for (const p of lowerScan.pages) for (const w of p.widgets) for (const n of w.mxNames) lowerWidgets.add(n);

  // Mendix's own auto-generated default name for an un-renamed widget —
  // "container10", "text11", "actionButton2" — is NOT a reliable identity
  // signal across pages. Verified directly against this project's real
  // scans (2026-09-11): 145+ of ~158 widget names in the admin scan alone
  // still carry a default name, and BasePage.js's logout() comment already
  // documents one real collision (actionButton2 shared by the logout
  // button AND every row's edit button). A first pass of this script
  // WITHOUT this guard reported 5 "findings" for collaborateur vs admin —
  // every one was container10/text11/staticImage13-style defaults that
  // just happen to also exist, unrelated, on collaborateur's own pages.
  // That's not a security finding, it's name-collision noise, and shipping
  // it as one would train a tester to ignore real findings from this tool.
  //
  // So: a default-named widget is only treated as a usable identity signal
  // when it ALSO carries distinguishing visible text that can be checked
  // for a match — an un-renamed *label with text* rarely collides in both
  // name AND wording by chance, unlike a bare empty container/button. A
  // default-named widget with no text at all is skipped outright rather
  // than guessed about. A custom-named widget (a human actually renamed it
  // in Studio Pro) is trustworthy on its own — that's specific enough that
  // an accidental collision is implausible.
  const DEFAULT_NAME_RE = /^[a-zA-Z]+[0-9]+(-[0-9]+)*$/;
  const isDefaultName = (n) => DEFAULT_NAME_RE.test(n);

  // Exclusive = named widgets the higher role's scan actually rendered that
  // never once appeared anywhere in the lower role's own scan — real set
  // difference over ground-truth data, not an assumption about what a role
  // "should" see.
  const higherOnly = new Map(); // widget name -> {tag, text} from first sighting
  let skippedUnidentifiable = 0;
  for (const p of higherScan.pages) {
    for (const w of p.widgets) {
      for (const n of w.mxNames) {
        if (lowerWidgets.has(n) || higherOnly.has(n)) continue;
        if (isDefaultName(n) && !w.text.trim()) {
          skippedUnidentifiable++;
          continue;
        }
        higherOnly.set(n, { tag: w.tag, text: w.text, requiresTextMatch: isDefaultName(n) });
      }
    }
  }
  if (skippedUnidentifiable) {
    console.log(`Skipped ${skippedUnidentifiable} default-named, textless widget(s) — a bare "container10"/"actionButton3" style name with no text isn't a reliable enough signal to compare across roles (see this script's header comment).`);
  }

  if (!higherOnly.size) {
    console.log(
      `No widgets found in "${higherRole}"'s scan that were absent from "${lowerRole}"'s scan — nothing distinguishes them in what's been crawled so far (or the scans are too shallow to tell). Nothing to check.`
    );
    process.exit(0);
  }
  console.log(`${higherOnly.size} widget(s) seen only for "${higherRole}", never for "${lowerRole}". Checking whether they're actually reachable while logged in as "${lowerRole}"...`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const basePage = new BasePage(page);

  console.log(`Logging in as "${lowerRole}"...`);
  await page.goto(baseUrl);
  const { status, body } = await submitLogin(basePage, { username, password });
  basePage.expectApiSuccess({ status, body });
  await basePage.waitForMendixIdle();

  const findings = [];
  const checkHere = async (whereLabel) => {
    for (const [name, info] of higherOnly) {
      const locator = basePage.mx(name).first();
      const visible = await locator.isVisible({ timeout: 400 }).catch(() => false);
      if (!visible) continue;
      if (info.requiresTextMatch) {
        // Default-named widget — only count it if the text visible on THIS
        // element for the lower role actually matches what the higher
        // role's scan recorded, not just the name. A name match alone is
        // exactly the false-positive pattern this script's header explains.
        const currentText = (await locator.innerText({ timeout: 400 }).catch(() => "")).trim();
        if (currentText.toLowerCase() !== info.text.trim().toLowerCase()) continue;
      }
      findings.push({ widget: name, tag: info.tag, text: info.text, seenAt: whereLabel });
    }
  };

  await checkHere("landing page");

  // Best-effort: retrace the SAME nav clicks the lower role's own scan took,
  // so exclusive widgets that only render on a sub-page the lower role CAN
  // reach (as opposed to ones needing a page it can't get to at all) are
  // also checked. A click failing here (e.g. that nav item genuinely isn't
  // present for this role) just skips that stop rather than aborting the
  // whole scan.
  for (const p of lowerScan.pages) {
    if (p.label === "landing page") continue;
    try {
      const stillThere = await basePage.mx(p.label).first().isVisible({ timeout: 2000 }).catch(() => false);
      if (!stillThere) continue;
      await basePage.mx(p.label).first().click({ timeout: 5000 });
      await basePage.waitForMendixIdle();
      await checkHere(p.label);
      await page.goBack({ timeout: 8000 }).catch(() => {});
      await basePage.waitForMendixIdle();
    } catch (err) {
      console.log(`  (skipped retracing "${p.label}": ${err.message.split("\n")[0]})`);
    }
  }

  await basePage.logout().catch(() => {});
  await browser.close();

  // De-dup: the same widget can be found visible at more than one stop.
  const byWidget = new Map();
  for (const f of findings) {
    if (!byWidget.has(f.widget)) byWidget.set(f.widget, { ...f, seenAt: [f.seenAt] });
    else byWidget.get(f.widget).seenAt.push(f.seenAt);
  }
  const uniqueFindings = [...byWidget.values()];

  const result = {
    lowerRole,
    higherRole,
    scannedAt: Date.now(),
    exclusiveWidgetCount: higherOnly.size,
    skippedUnidentifiableCount: skippedUnidentifiable,
    findings: uniqueFindings,
    note:
      uniqueFindings.length > 0
        ? "A widget listed here was rendered and visible while logged in as the lower-privilege role, despite never appearing in that role's own App Scan crawl. This means the UI exposes it — it does NOT by itself confirm the underlying Mendix microflow/entity action would actually execute for this role (Mendix commonly enforces that separately, server-side). Verify by hand before treating this as a confirmed bypass."
        : "No exclusive widgets from the higher role's scan were found visible while logged in as the lower role, across the pages checked. This is reassuring but not exhaustive — it only covers widgets the App Scanner actually found for the higher role, and only the pages the lower role's own scan reached.",
  };

  const outDir = path.join(paths.explorer, "auth-boundary-scan");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${lowerRole}-vs-${higherRole}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (uniqueFindings.length) {
    console.log(`\n${uniqueFindings.length} finding(s) — widget(s) visible to "${lowerRole}" despite being ${higherRole}-exclusive in the App Scan:`);
    for (const f of uniqueFindings) {
      console.log(`- ${f.widget} (${f.tag}${f.text ? `, "${f.text}"` : ""}) — seen at: ${f.seenAt.join(", ")}`);
    }
  } else {
    console.log(`\nNo findings — none of the ${higherOnly.size} exclusive widget(s) were visible to "${lowerRole}" at the pages checked.`);
  }
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
