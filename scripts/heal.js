#!/usr/bin/env node
/**
 * Self-healing, single-widget mode. Same grounding rule as everywhere else
 * in this project: never guessed, always replayed — but (as of 2026-09-11)
 * against the EXISTING TEST's own code (replaySpecAndSnapshotWidgets in
 * scripts/replay-widgets.js), not a separately-kept raw recording.
 *
 * Previously this replayed the test's original raw codegen recording
 * (explorer/raw-<role>-<flow>.spec.js) — a file that's gitignored, not
 * guaranteed to still be on disk, and redundant: the generated spec.js
 * already knows exactly how to get to the relevant page, since it's a real,
 * working Playwright test. If a locator changed, there's no reason to go
 * looking for it in an old recording instead of just running the test's own
 * steps against the app right now and seeing what's actually there — see
 * scripts/heal-scan.js, which this now shares its replay engine with. This
 * script is the same idea narrowed to one widget name you already know is
 * broken, instead of scanning the whole file for every broken locator.
 *
 * The result is written as a "fix" proposal to the pending review queue
 * (same place scripts/record-and-enrich.js --stage writes new tests) —
 * never applied automatically. A human approves it in the UI, same as any
 * other AI-generated change to a test.
 *
 * Usage:
 *   node scripts/heal.js <role> <flow-name> <old-widget-name> [--project <name>]
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { loadProjectEnv, projectPaths, projectExists, writePending } from "./project.js";
import { replaySpecAndSnapshotWidgets } from "./replay-widgets.js";
import { scoreTestQuality } from "./confidence.js";

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const [role, flowName, oldWidget] = argv;
if (!role || !flowName || !oldWidget) {
  console.error("Usage: node scripts/heal.js <role> <flow-name> <old-widget-name> [--project <name>]");
  process.exit(1);
}

if (!projectExists(projectName)) {
  const paths = projectPaths(projectName);
  console.error(`Project "${paths.name}" doesn't exist (looked for ${paths.root}).`);
  process.exit(1);
}
await loadProjectEnv(projectName);
const paths = projectPaths(projectName);

const specPath = path.join(paths.generatedTests, role, `${flowName}.spec.js`);
if (!fs.existsSync(specPath)) {
  console.error(`No existing test at ${specPath} — nothing to heal.`);
  process.exit(1);
}

if (!process.env.BASE_URL) {
  console.error(`BASE_URL not set in ${paths.env} — needed to run the test's own page.goto('/') against the live app.`);
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in your environment first.");
  process.exit(1);
}

async function main() {
  const currentContent = fs.readFileSync(specPath, "utf-8");

  const mxCallRe = new RegExp(`mx\\('${oldWidget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\)`, "g");
  if (!mxCallRe.test(currentContent)) {
    console.error(`"${oldWidget}" doesn't actually appear as a mx('${oldWidget}') call in ${specPath} — nothing to replace.`);
    process.exit(1);
  }

  console.log(`Running ${role}/${flowName}.spec.js's own steps against the app right now to find what "${oldWidget}" was renamed to...`);
  const replaySteps = await replaySpecAndSnapshotWidgets(currentContent, { baseUrl: process.env.BASE_URL, specPath });

  const failedSteps = replaySteps.filter((s) => !s.ok);
  if (failedSteps.length) {
    console.log(`${failedSteps.length} of ${replaySteps.length} step(s) didn't complete as written:`);
    for (const s of failedSteps) console.log(`- "${s.step}": ${s.replayError}`);
  }

  const allCurrentWidgets = [];
  const seen = new Set();
  for (const step of replaySteps) {
    for (const w of step.newlyVisibleWidgets) {
      const key = w.mxNames.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      allCurrentWidgets.push(w);
    }
  }

  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });

  const system = `A Playwright locator in a Mendix test is failing because the widget it targets,
"${oldWidget}", no longer exists in the app's DOM — it may have been renamed in Mendix Studio
Pro, or removed. You are given the CURRENT set of mx-name-* widgets actually visible when
replaying the same flow just now (ground truth from a real browser, not a guess).

Find the widget in the current list that most likely replaced "${oldWidget}" — consider tag,
position/order relative to other widgets, and visible text. Do NOT invent a name that isn't in
the list below. If nothing looks like a plausible match, say so honestly with low confidence
rather than picking an unrelated widget.

Respond with ONLY a JSON object, no markdown fences:
{
  "newWidget": "<bare widget name from the list, or null if no plausible match>",
  "confidence": <integer 0-100>,
  "reasoning": "one short sentence explaining the match (or why there's no good match)"
}`;

  const userMsg = `Old widget name that's now failing: ${oldWidget}

Current widgets visible when replaying this flow just now:
${JSON.stringify(allCurrentWidgets, null, 2)}`;

  const response = await client.chat.completions.create({
    model: "openai/gpt-oss-120b",
    max_tokens: 300,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
  });

  const text = (response.choices[0].message.content || "").trim();
  const jsonText = text.replace(/^```(json)?\n?/, "").replace(/```$/, "");
  const result = JSON.parse(jsonText);

  if (!result.newWidget) {
    console.log(`No confident replacement found. Reasoning: ${result.reasoning}`);
    console.log("Nothing written — this needs a human to look at it directly (or use Update (re-record)).");
    process.exit(2);
  }

  // Only the literal string argument to mx(), not any chained .filter() —
  // preserves whatever disambiguation the original enrichment already added.
  const patched = currentContent.replace(mxCallRe, `mx('${result.newWidget}')`);

  const id = `${role}-${flowName}-fix`;
  const dir = writePending(projectName, id, {
    type: "fix",
    role,
    flowName,
    specText: patched,
    previousText: currentContent,
    oldWidget,
    newWidget: result.newWidget,
    confidence: result.confidence,
    reasoning: result.reasoning,
    quality: scoreTestQuality(patched),
  });

  console.log(`Proposed fix: ${oldWidget} -> ${result.newWidget} (confidence: ${result.confidence}%)`);
  console.log(`Reasoning: ${result.reasoning}`);
  console.log(`Staged for review at ${dir} — review and approve it in the UI.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
