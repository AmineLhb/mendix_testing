#!/usr/bin/env node
/**
 * Turns the JUnit XML CI already produces into a short markdown summary for
 * a PR comment (see .github/workflows/regression.yml's "PR comment" step,
 * which uses actions/github-script to post/update it). No XML library —
 * junit.xml's root <testsuites> attributes are simple enough for a
 * per-attribute regex, and this avoids adding a dependency for one read.
 *
 * Usage: node scripts/pr-comment-summary.js [path-to-junit.xml]
 */
import fs from "node:fs";

const junitPath = process.argv[2] || "projects/OccupationalMedicine/test-results/junit.xml";

if (!fs.existsSync(junitPath)) {
  console.log(`No JUnit results found at ${junitPath}.`);
  process.exit(0);
}

const xml = fs.readFileSync(junitPath, "utf-8");
const rootMatch = xml.match(/<testsuites[^>]*>/);
const root = rootMatch ? rootMatch[0] : "";

function attr(name) {
  const m = root.match(new RegExp(`${name}="([^"]*)"`));
  return m ? Number(m[1]) : 0;
}

const tests = attr("tests");
const failures = attr("failures");
const skipped = attr("skipped");
const time = attr("time");
const passed = Math.max(0, tests - failures - skipped);

const failedNames = Array.from(xml.matchAll(/<testcase[^>]*\bname="([^"]*)"[^>]*>(?:(?!<\/testcase>).)*<failure/gs), (m) => m[1]).slice(0, 10);

const icon = tests === 0 ? "⚠️" : failures > 0 ? "❌" : "✅";
const lines = [
  tests === 0
    ? `${icon} No tests ran — check the workflow log.`
    : `${icon} **${passed}/${tests} E2E tests passed** (${failures} failed, ${skipped} skipped) in ${time.toFixed(1)}s`,
];
if (failedNames.length) {
  lines.push("", "Failed:", ...failedNames.map((n) => `- ${n}`));
  if (failures > failedNames.length) lines.push(`- …and ${failures - failedNames.length} more`);
}

console.log(lines.join("\n"));
