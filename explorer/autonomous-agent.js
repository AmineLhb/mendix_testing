/**
 * Phase D (optional/advanced) — Autonomous exploration.
 *
 * Lets an LLM drive the browser step by step to poke around the app
 * looking for broken flows/errors you didn't think to script. This is
 * exploratory (like a human tester randomly clicking around) — treat its
 * output as a list of findings to triage, NOT as a deterministic
 * regression suite. For that, use the Record -> Enrich -> Regress flow
 * in enrich.js instead.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_... node explorer/autonomous-agent.js \
 *     https://your-mendix-app-url --steps 25
 */
import OpenAI from "openai";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { loadProjectEnv } from "../scripts/project.js";

await loadProjectEnv();

const appUrl = process.argv[2];
const stepsFlagIdx = process.argv.indexOf("--steps");
const maxSteps = stepsFlagIdx > -1 ? parseInt(process.argv[stepsFlagIdx + 1], 10) : 20;

if (!appUrl) {
  console.error("Usage: node explorer/autonomous-agent.js <app-url> [--steps N]");
  process.exit(1);
}

async function snapshotWidgets(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="mx-name-"]'));
    return els.slice(0, 200).map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      mxName: (el.className.match(/mx-name-\S+/) || [""])[0],
      text: (el.textContent || "").trim().slice(0, 60),
      type: el.getAttribute("type"),
      visible: !!(el.offsetWidth || el.offsetHeight),
    })).filter((w) => w.visible && w.mxName);
  });
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("Set GROQ_API_KEY in your environment first.");
    process.exit(1);
  }
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(appUrl, { waitUntil: "networkidle" });

  const log = [];
  const findings = [];

  const system = `You are exploring a Mendix web app like a manual QA tester looking for bugs.
Each turn you get a list of currently visible widgets (mx-name-* classes). Reply with
ONLY a JSON object: {"action": "click"|"fill"|"assert_ok"|"stop", "mxName": "...",
"value": "... (only for fill)", "note": "short reason / what you're checking"}.
Prefer actions that move forward through a plausible real user flow (login, create
a record, navigate a grid, edit, delete) over re-clicking the same thing. If
something looks broken (error text visible, a button did nothing, layout looks
wrong from the widget list), set "action":"assert_ok" is not right — instead use
"note" to describe the problem and keep "action":"click" on your next best guess,
or "stop" if you're stuck.`;

  for (let step = 0; step < maxSteps; step++) {
    const widgets = await snapshotWidgets(page);
    const errorText = await page
      .locator(".mx-error, .modal-error, .alert-danger")
      .allInnerTexts()
      .catch(() => []);

    const msg = await client.chat.completions.create({
      model: "openai/gpt-oss-120b",
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Step ${step + 1}/${maxSteps}. Current URL: ${page.url()}
Visible errors: ${JSON.stringify(errorText)}
Visible widgets: ${JSON.stringify(widgets)}`,
        },
      ],
    });

    let action;
    try {
      const raw = msg.choices[0].message.content || "";
      action = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    } catch {
      break; // model didn't return parseable JSON — stop rather than guess
    }

    log.push({ step, url: page.url(), action });
    if (errorText.length) findings.push({ step, url: page.url(), errorText });

    if (action.action === "stop") break;

    const locator = page.locator(`.${action.mxName}`);
    try {
      if (action.action === "click") await locator.first().click({ timeout: 5000 });
      if (action.action === "fill") await locator.first().fill(action.value ?? "", { timeout: 5000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    } catch (e) {
      findings.push({ step, url: page.url(), toolError: String(e), attempted: action });
    }
  }

  await browser.close();

  fs.writeFileSync("explorer/exploration-log.json", JSON.stringify(log, null, 2));
  fs.writeFileSync("explorer/exploration-findings.json", JSON.stringify(findings, null, 2));
  console.log(`Done. ${log.length} steps taken, ${findings.length} potential issues logged.`);
  console.log(`See explorer/exploration-findings.json — turn any real bugs into a`);
  console.log(`recorded test via 'npm run record' + 'npm run enrich'.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
