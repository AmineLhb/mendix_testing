#!/usr/bin/env node
/**
 * Natural-Language Test Generation (capped at the roadmap's own V1/V2:
 * "Generate BDD" + a best-effort grounding attempt — NOT V3/V4, which would
 * mean actually executing/validating the result, and this tool's whole
 * premise is that a locator is never trusted without a real replay behind
 * it). Given a plain-English description of a flow, produces a BDD
 * Given/When/Then PLAN — not executable Playwright code — with each step
 * tentatively mapped to a real widget name IF one exists in that role's
 * most recent App Scanner output (explorer/app-scan/<role>.json).
 *
 * Steps that can't be mapped to a real scanned widget are marked
 * unresolved rather than guessed — the model is explicitly told not to
 * invent a widget name. Turning an unresolved plan into an actual test
 * still means recording the flow for real (npm run new-test), the same as
 * every other test in this project; this is a planning aid, not a
 * replacement for that.
 *
 * Usage: node scripts/generate-from-description.js <role> "<description>" [--project <name>]
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { loadProjectEnv, projectPaths, projectExists, readProjectRoles } from "./project.js";

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const idIdx = argv.indexOf("--id");
const explicitId = idIdx > -1 ? argv[idIdx + 1] : undefined;
if (idIdx > -1) argv.splice(idIdx, 2);

// Free-text descriptions are handed to the server-spawned job via
// MENDIX_NL_DESCRIPTION instead of a CLI arg — verified 2026-09-10:
// jobs.js's spawn(cmd, args, { shell: true }) word-splits a multi-word array
// argument on Windows (cmd.exe re-parses the joined command line rather than
// treating each array element as pre-quoted), so a spaces-containing CLI arg
// silently truncates to its first word. An env var is set directly on the
// child's environment block, bypassing shell re-parsing entirely. Direct CLI
// usage (a human typing a quoted string in their own shell) still works via
// the positional arg — that quoting happens in the interactive shell itself,
// before Node ever sees argv, so it was never affected by this bug.
const [role] = argv;
const description = argv[1] ?? process.env.MENDIX_NL_DESCRIPTION;
if (!role || !description) {
  console.error('Usage: node scripts/generate-from-description.js <role> "<description>" [--project <name>]');
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

if (!process.env.GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in your environment first.");
  process.exit(1);
}

const scanPath = path.join(paths.explorer, "app-scan", `${role}.json`);
let scannedWidgets = [];
let scanInfo = "No App Scan on file for this role yet — every step will be unresolved. Run the App Scanner first for real widget grounding.";
if (fs.existsSync(scanPath)) {
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf-8"));
  const seen = new Set();
  for (const p of scan.pages) {
    for (const w of p.widgets) {
      const key = w.mxNames.join(",");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      scannedWidgets.push({ mxNames: w.mxNames, tag: w.tag, text: w.text, page: p.label });
    }
  }
  scanInfo = `${scannedWidgets.length} real widget(s) known from the last App Scan (${new Date(scan.scannedAt).toISOString()}).`;
}

const system = `You turn a plain-English description of a user flow into a BDD Given/When/Then
PLAN for a Mendix app test — not executable code, a plan a human will review before
recording the actual test.

You are given the REAL widgets known from a live app scan (ground truth — never invent a
name that isn't in this list). For each step, if a widget from the list plausibly matches
what the step needs, reference its bare name (no "mx-name-" prefix). If nothing in the
list matches, set "widget" to null and "resolved" to false — do NOT guess a plausible-
sounding name.

Respond with ONLY a JSON object, no markdown fences:
{
  "steps": [
    { "type": "Given"|"When"|"Then"|"And", "description": "plain-English step", "widget": "<bare mx name or null>", "resolved": <bool> }
  ],
  "unresolvedCount": <integer>,
  "summary": "one sentence on how grounded this plan is overall"
}`;

const userMsg = `Role: ${role}
Description: ${description}

${scanInfo}
Known widgets:
${JSON.stringify(scannedWidgets, null, 2)}`;

async function main() {
  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
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
  const result = JSON.parse(jsonText);

  const outDir = path.join(paths.explorer, "nl-plans");
  fs.mkdirSync(outDir, { recursive: true });
  const id = explicitId || `${role}-${Date.now()}`;
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ role, description, generatedAt: Date.now(), ...result }, null, 2));

  console.log(`Plan (${result.steps.length} step(s), ${result.unresolvedCount} unresolved):\n`);
  for (const s of result.steps) {
    console.log(`  ${s.type} ${s.description}${s.resolved ? ` [${s.widget}]` : " [UNRESOLVED — needs recording]"}`);
  }
  console.log(`\n${result.summary}`);
  console.log(`\nSaved to ${outPath}. This is a plan, not a runnable test — record the flow for real (npm run new-test) to turn it into one, using this as a guide for what to click through.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
