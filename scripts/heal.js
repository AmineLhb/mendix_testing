#!/usr/bin/env node
/**
 * Self-healing, done the same way this project trusts anything else about
 * the app's DOM: never guessed, always replayed. Given a locator that's
 * started failing (e.g. mx-name-Input_Email got renamed to
 * mx-name-Input_EmailAddress in Studio Pro), this does NOT ask the model to
 * pattern-match a plausible-looking new name out of thin air — it replays
 * the test's ORIGINAL raw recording (still on disk from when the test was
 * first created) against the CURRENT live app, using the exact same replay
 * mechanism explorer/enrich.js uses for generation, and only lets the model
 * pick a replacement from widgets that are actually visible right now.
 *
 * The result is written as a "fix" proposal to the pending review queue
 * (same place scripts/record-and-enrich.js --stage writes new tests) —
 * never applied automatically. A human approves it in the UI, same as any
 * other AI-generated change to a test.
 *
 * Usage:
 *   node scripts/heal.js <role> <flow-name> <old-widget-name> [--project <name>]
 *
 * Requires: the test's original raw recording still on disk at
 * explorer/raw-<role>-<flow-name>.spec.js (present unless it's been
 * manually deleted — it's gitignored but not removed after enrichment),
 * and the test itself already existing in generated-tests/<role>/.
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { loadProjectEnv, projectPaths, projectExists, writePending } from "./project.js";
import { replayAndSnapshotWidgets } from "./replay-widgets.js";

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

const rawPath = path.join(paths.explorer, `raw-${role}-${flowName}.spec.js`);
if (!fs.existsSync(rawPath)) {
  console.error(
    `Original raw recording not found at ${rawPath} — can't replay to find the current widget map without it. ` +
      `(It's kept on disk after enrichment specifically so healing can use it later; if it's gone, re-recording the flow is the only option.)`
  );
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in your environment first.");
  process.exit(1);
}

async function main() {
  const rawScript = fs.readFileSync(rawPath, "utf-8");
  console.log(`Replaying ${rawPath} against the current app to find what "${oldWidget}" was renamed to...`);
  const replaySteps = await replayAndSnapshotWidgets(rawScript);

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
    console.log("Nothing written — this needs a human to look at it directly (or re-record the flow).");
    process.exit(2);
  }

  const currentContent = fs.readFileSync(specPath, "utf-8");
  // Only the literal string argument to mx(), not any chained .filter() —
  // preserves whatever disambiguation the original enrichment already added.
  const mxCallRe = new RegExp(`mx\\('${oldWidget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\)`, "g");
  if (!mxCallRe.test(currentContent)) {
    console.error(`"${oldWidget}" doesn't actually appear as a mx('${oldWidget}') call in ${specPath} — nothing to replace.`);
    process.exit(1);
  }
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
  });

  console.log(`Proposed fix: ${oldWidget} -> ${result.newWidget} (confidence: ${result.confidence}%)`);
  console.log(`Reasoning: ${result.reasoning}`);
  console.log(`Staged for review at ${dir} — review and approve it in the UI.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
