/**
 * AI failure analysis: sends a failed test's error to Groq and returns a
 * plain-English diagnosis instead of leaving a raw Playwright stack trace as
 * the only thing to go on. `analyzeFailure`/`formatAnalysis` are called from
 * scripts/test-history-reporter.js's onTestEnd (not from a separate reporter
 * class here) — merged into that one reporter so there's exactly one Groq
 * call per failure and the analysis gets persisted onto the same history
 * entry the Tests tab already reads, not just printed and discarded.
 *
 * Inert without GROQ_API_KEY (returns an error object instead of throwing) —
 * this is a value-add on top of the real Playwright error, never a
 * replacement for it, and a missing/expired key or a Groq outage must
 * never break the actual test run.
 */
import OpenAI from "openai";

let client = null;
function getClient() {
  if (!process.env.GROQ_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
  }
  return client;
}

const SYSTEM_PROMPT = `You analyze a single failed Playwright test against a Mendix web app and
explain it in plain English for a tester who isn't necessarily a Playwright expert.

Respond with ONLY a JSON object, no markdown fences, no explanation outside it:
{
  "whatHappened": "one or two plain-English sentences describing what the test was trying to do and what went wrong",
  "likelyCause": "your best inference of the root cause, in plain English — consider things like: a locator that no longer matches anything (renamed/removed widget), a timing issue (action fired before the app finished an async server round-trip), a genuine app/business-logic bug, or an environment issue (e.g. a Mendix "license does not allow more users to sign in" error, which is a known seat-cap issue on this project, not a code bug)",
  "recommendedAction": "one concrete, specific next step — e.g. 're-record this step to get the widget's current name', 'add a waitForMendixIdle() before this action', 'this is an environment issue, not a code bug — no action needed on the test itself'",
  "confidence": <integer 0-100, your confidence in this diagnosis>
}

Keep every field short — 1-3 sentences max, no code blocks, no restating the raw error verbatim.`;

/** Exported separately from the reporter class so it's unit-testable without
 * running a real Playwright test (see scripts/verify-ai-failure-reporter.js). */
export async function analyzeFailure({ testTitle, filePath, errorMessage }) {
  const c = getClient();
  if (!c) return null;

  const userMsg = `Test: ${testTitle}
File: ${filePath}

Error:
${(errorMessage || "").slice(0, 2000)}`;

  try {
    const response = await c.chat.completions.create({
      model: "openai/gpt-oss-120b",
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    });
    const text = (response.choices[0].message.content || "").trim();
    const jsonText = text.replace(/^```(json)?\n?/, "").replace(/```$/, "");
    return JSON.parse(jsonText);
  } catch (err) {
    return { error: `AI failure analysis unavailable: ${err.message}` };
  }
}

export function formatAnalysis(analysis) {
  if (!analysis) return null;
  if (analysis.error) return `\nAI Failure Analysis\n  ${analysis.error}\n`;
  const lines = [
    "",
    "AI Failure Analysis",
    "What happened",
    `  ${analysis.whatHappened}`,
    "",
    "Likely cause",
    `  ${analysis.likelyCause}`,
    "",
    "Recommended action",
    `  ${analysis.recommendedAction}`,
    "",
    `Confidence: ${analysis.confidence}%`,
    "",
  ];
  return lines.join("\n");
}
