#!/usr/bin/env node
/**
 * Self-heal, SCAN mode — generalizes heal.js from "fix the one widget name
 * I typed in" to "find every locator in this test that no longer resolves,
 * automatically". Same grounding rule as heal.js and everywhere else in this
 * project: never guessed, always replayed — but against the EXISTING TEST's
 * own code (see replay-spec-and-snapshot-widgets in scripts/replay-widgets.js),
 * not a separately-kept raw recording. The generated spec.js already knows
 * exactly how to get to the relevant page (it's a real, working Playwright
 * test); there's no reason a locator check should depend on a second file
 * still being on disk just to navigate there again.
 *
 * Collects every mx-name-* widget actually visible while running the test's
 * own steps against the CURRENT live app, then checks every `mx('...')`
 * locator the test references against that real list — a locator whose
 * widget isn't in the list is broken, everything else is left untouched.
 *
 * A broken locator only gets a proposed replacement when the model finds a
 * confident match (>= CONFIDENCE_THRESHOLD) among the CURRENT widgets — one
 * with no confident match is reported as unresolved and left as-is in the
 * patched spec, rather than guessing something that could silently turn a
 * passing assertion into a wrong one.
 *
 * The result (patched spec + a list of applied fixes + a list of unresolved
 * locators) is written as a "fix" proposal to the same pending review queue
 * as heal.js and a new recording — never applied automatically.
 *
 * Usage:
 *   node scripts/heal-scan.js <role> <flow-name> [--project <name>]
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { loadProjectEnv, projectPaths, projectExists, writePending } from "./project.js";
import { replaySpecAndSnapshotWidgets } from "./replay-widgets.js";
import { scoreTestQuality } from "./confidence.js";

const CONFIDENCE_THRESHOLD = 50;

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const [role, flowName] = argv;
if (!role || !flowName) {
  console.error("Usage: node scripts/heal-scan.js <role> <flow-name> [--project <name>]");
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
  console.error(`No existing test at ${specPath} — nothing to scan.`);
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
  const specContent = fs.readFileSync(specPath, "utf-8");
  console.log(`Running ${role}/${flowName}.spec.js's own steps against the app right now to check every locator it uses...`);
  const replaySteps = await replaySpecAndSnapshotWidgets(specContent, { baseUrl: process.env.BASE_URL, specPath });

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
  const currentNames = new Set(allCurrentWidgets.flatMap((w) => w.mxNames));

  const mxCallRe = /mx\('([^']+)'\)/g;
  const referencedWidgets = [...new Set(Array.from(specContent.matchAll(mxCallRe), (m) => m[1]))];
  const brokenWidgets = referencedWidgets.filter((w) => !currentNames.has(w));

  if (!brokenWidgets.length) {
    console.log(`All ${referencedWidgets.length} locator(s) in ${role}/${flowName}.spec.js still resolve against the current app — nothing to heal.`);
    process.exit(0);
  }
  console.log(`${brokenWidgets.length} of ${referencedWidgets.length} locator(s) no longer resolve: ${brokenWidgets.join(", ")}`);

  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });

  const system = `Playwright locators in a Mendix test are failing because the widgets they target
no longer exist in the app's DOM — they may have been renamed in Studio Pro, or removed. You are
given the CURRENT set of mx-name-* widgets actually visible when replaying the same flow just now
(ground truth from a real browser, not a guess), and a list of OLD widget names that are now broken.

For EACH old widget name, find the widget in the current list that most likely replaced it —
consider tag, position/order relative to other widgets, and visible text. Do NOT invent a name
that isn't in the current list. If nothing looks like a plausible match for a given old widget,
say so honestly with low confidence rather than picking an unrelated widget — a wrong guess here
can silently break a test that used to pass.

Respond with ONLY a JSON object, no markdown fences:
{
  "fixes": [
    { "oldWidget": "<exact old name from the list given>", "newWidget": "<bare widget name from the current list, or null if no plausible match>", "confidence": <integer 0-100>, "reasoning": "one short sentence" }
  ]
}
One entry per old widget name given, in any order.`;

  const userMsg = `Old widget names that are now failing:
${JSON.stringify(brokenWidgets, null, 2)}

Current widgets visible when replaying this flow just now:
${JSON.stringify(allCurrentWidgets, null, 2)}`;

  const response = await client.chat.completions.create({
    model: "openai/gpt-oss-120b",
    max_tokens: 1500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
  });

  const text = (response.choices[0].message.content || "").trim();
  const jsonText = text.replace(/^```(json)?\n?/, "").replace(/```$/, "");
  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    console.error(`Groq's response wasn't valid JSON (${err.message}). Raw response:\n${text}`);
    process.exit(1);
  }

  let patched = specContent;
  const applied = [];
  const unresolved = [];
  for (const fix of result.fixes || []) {
    if (!fix.newWidget || fix.confidence < CONFIDENCE_THRESHOLD) {
      unresolved.push({ oldWidget: fix.oldWidget, confidence: fix.confidence ?? 0, reasoning: fix.reasoning || "No confident match." });
      continue;
    }
    const mxCallReplace = new RegExp(`mx\\('${fix.oldWidget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\)`, "g");
    if (!mxCallReplace.test(patched)) continue; // already handled / not literally present — skip rather than guess why
    patched = patched.replace(mxCallReplace, `mx('${fix.newWidget}')`);
    applied.push({ oldWidget: fix.oldWidget, newWidget: fix.newWidget, confidence: fix.confidence, reasoning: fix.reasoning });
  }

  if (!applied.length) {
    console.log("No confident replacement found for any broken locator. Reasoning:");
    for (const u of unresolved) console.log(`- ${u.oldWidget}: ${u.reasoning}`);
    console.log("Nothing written — this needs a human to look at it directly (or use Update (re-record)).");
    process.exit(2);
  }

  const id = `${role}-${flowName}-fix`;
  const dir = writePending(projectName, id, {
    type: "fix",
    role,
    flowName,
    specText: patched,
    previousText: specContent,
    fixes: applied,
    unresolved,
    quality: scoreTestQuality(patched),
  });

  console.log(`\n${applied.length} fix(es) proposed:`);
  for (const f of applied) console.log(`- ${f.oldWidget} -> ${f.newWidget} (confidence ${f.confidence}%)`);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} locator(s) still need a human look (no confident match):`);
    for (const u of unresolved) console.log(`- ${u.oldWidget}: ${u.reasoning}`);
  }
  console.log(`\nStaged for review at ${dir} — review and approve it in the UI.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
