#!/usr/bin/env node
/**
 * AI-Generated Assertions (V1: suggestions only — see roadmap's own
 * evolution ladder, "V1: Suggestions" before "V2: automatic for
 * high-confidence cases"). Reads an EXISTING generated test and asks the
 * model for additional assertions it could reasonably add, preferring
 * business outcomes over implementation details (the roadmap's own example:
 * "the invoice status should be Pending" over "button #3 should exist").
 *
 * Deliberately does NOT auto-insert anything into the spec file — unlike
 * enrich.js/heal.js, there's no real-replay grounding step here to verify a
 * suggested assertion would actually pass, so auto-applying one could
 * silently break a currently-passing test. Suggestions are informational;
 * a human decides whether/how to add one.
 *
 * Usage: node scripts/suggest-assertions.js <role> <flow-name> [--project <name>]
 */
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { loadProjectEnv, projectPaths, projectExists } from "./project.js";

const argv = process.argv.slice(2);
const projectIdx = argv.indexOf("--project");
const projectName = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
if (projectIdx > -1) argv.splice(projectIdx, 2);

const [role, flowName] = argv;
if (!role || !flowName) {
  console.error("Usage: node scripts/suggest-assertions.js <role> <flow-name> [--project <name>]");
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
  console.error(`No existing test at ${specPath}.`);
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in your environment first.");
  process.exit(1);
}

const specText = fs.readFileSync(specPath, "utf-8");

const system = `You review an existing Playwright test for a Mendix app and suggest
ADDITIONAL assertions it could reasonably add — the test already runs correctly; you are
not changing its actions, only proposing more verification.

Rules:
- Only suggest assertions for behavior the test's own actions already imply (e.g. if it
  clicks Save, a "record was saved" or "success notification shown" assertion is
  reasonable; do not invent behavior the recording never exercised).
- Prefer business outcomes over implementation details — "the invoice status should be
  Pending" is good, "button #3 should exist" is not.
- Reference only mx-name-* widgets or text that ALREADY appear literally somewhere in the
  given spec text — never invent a widget name that isn't already used in the file, since
  there is no live replay here to verify one would actually resolve.
- Each suggestion needs a one-sentence rationale and a confidence as an INTEGER 0-100
  (never a word like "medium" or "high") — be honest about low confidence rather than
  padding it.
- At most 5 suggestions, ranked most valuable first — this is a request for the best
  ideas, not an exhaustive list, and a long response risks being cut off before it's
  valid JSON.
- Keep "exampleCode" to a single short line — no embedded newlines, no multi-statement
  snippets.

Respond with ONLY a JSON object, no markdown fences:
{
  "suggestions": [
    { "afterStep": "<the exact test.step() label text this belongs after>", "assertion": "plain-English description of what to check", "exampleCode": "one line of Playwright code, e.g. await expect(basePage.mx('...')).toContainText('...')", "confidence": <integer 0-100>, "rationale": "one sentence" }
  ]
}
If nothing reasonable to add, return { "suggestions": [] } — do not pad with weak ones.`;

const userMsg = `Existing test (${role}/${flowName}.spec.js):\n\n${specText}`;

async function main() {
  const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
  const response = await client.chat.completions.create({
    model: "openai/gpt-oss-120b",
    // Generous headroom, not tight to the "usual" case — a truncated
    // response isn't just incomplete, it's INVALID JSON (verified
    // 2026-09-10: create-visit.spec.js's response hit the old 1200-token
    // cap mid-string, finish_reason "length", and crashed JSON.parse
    // instead of degrading gracefully). Capping suggestion count in the
    // prompt above bounds the response further regardless of file size.
    max_tokens: 2500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
  });
  const finishReason = response.choices[0].finish_reason;
  const text = (response.choices[0].message.content || "").trim();
  const jsonText = text.replace(/^```(json)?\n?/, "").replace(/```$/, "");

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    if (finishReason === "length") {
      console.error(
        `Groq's response was cut off before it finished (hit the ${2500}-token limit) and isn't valid JSON as a result. ` +
          "This usually means the model tried to return more suggestions than fit — try again, or suggest assertions for a shorter test."
      );
    } else {
      console.error(`Groq's response wasn't valid JSON (${err.message}). Raw response:\n${text}`);
    }
    process.exit(1);
  }

  // Confidence occasionally comes back as a word ("medium") despite the
  // instruction above — coerce rather than let a downstream consumer choke
  // on a non-numeric value.
  const WORD_CONFIDENCE = { low: 30, medium: 60, high: 85 };
  for (const s of result.suggestions || []) {
    if (typeof s.confidence !== "number") {
      s.confidence = WORD_CONFIDENCE[String(s.confidence).toLowerCase()] ?? 50;
    }
  }

  const outDir = path.join(paths.explorer, "assertion-suggestions");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${role}-${flowName}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ role, flowName, generatedAt: Date.now(), ...result }, null, 2));

  console.log(`${result.suggestions.length} suggestion(s):`);
  for (const s of result.suggestions) {
    console.log(`\n- ${s.assertion} (confidence ${s.confidence}%)`);
    console.log(`  After: "${s.afterStep}"`);
    console.log(`  ${s.exampleCode}`);
    console.log(`  ${s.rationale}`);
  }
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
