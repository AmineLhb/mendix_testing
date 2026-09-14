/**
 * Deterministic test-quality scoring — no LLM call, just inspects the
 * generated spec text itself. Kept separate from heal.js's confidence
 * (which is the model's own reported confidence in a specific locator
 * replacement): this is a general "how maintainable is this test" score,
 * computed the same way for a brand-new test or one already on disk.
 */

function pct(numerator, denominator, whenZero) {
  if (denominator === 0) return whenZero;
  return Math.round((numerator / denominator) * 100);
}

export function scoreTestQuality(specText) {
  // BDD structure: fraction of test.step() labels that actually start with
  // a Given/When/Then/And keyword (enrich.js's system prompt asks for this,
  // but nothing enforces it after the fact).
  const stepLabels = [...specText.matchAll(/test\.step\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  const bddLabels = stepLabels.filter((s) => /^(Given|When|Then|And)\b/.test(s.trim()));
  const bddStructure = pct(bddLabels.length, stepLabels.length, 0);

  // Locator stability: fraction of locator calls going through BasePage's
  // mx() helper (Mendix's stable per-widget class) vs. a raw page.locator()
  // call, which is far more likely to break on unrelated markup changes.
  const mxLocators = (specText.match(/\.mx\(/g) || []).length;
  const rawLocators = (specText.match(/page\.locator\(/g) || []).length;
  const locatorStability = pct(mxLocators, mxLocators + rawLocators, 100);

  // Assertions: at least one expect() per interactive action is the rough
  // bar for "this test actually checks something happened," not just
  // replaying clicks.
  const assertionCount = (specText.match(/\bexpect\(/g) || []).length;
  const actionCount = (specText.match(/\.(click|fill|check|uncheck|selectOption)\(/g) || []).length;
  const assertions = actionCount === 0 ? (assertionCount > 0 ? 100 : 0) : Math.min(100, pct(assertionCount, actionCount, 0));

  // Async handling: a fixed waitForTimeout() is exactly the kind of flaky,
  // unmaintainable wait this whole tool exists to replace with real
  // state-based waits (waitForMendixIdle()). Each one found costs points.
  const fixedWaits = (specText.match(/waitForTimeout\(/g) || []).length;
  const asyncHandling = Math.max(0, 100 - fixedWaits * 25);

  // Negative/boundary-path coverage: does this test check anything besides
  // the happy path? Looks for an error-message assertion, a rejected/failed
  // outcome check, or a step label that itself says it's testing an invalid
  // case — cheap signals, not a guarantee, but "0 of these" reliably means
  // "happy path only" the way it does for every hand-authored spec audited
  // while building this. Scored out of the step labels found (falls back to
  // 0 rather than 100 when there are no steps at all, unlike the other
  // metrics — an empty test isn't "fully covering" the negative path either).
  const negativePathSignals =
    (specText.match(/expectNoErrorMessage|expectApiSuccess|toBeVisible\(\)[\s\S]{0,80}expect.*error/gi) || []).length +
    (specText.match(/\b(incorrect|invalid|reject|fail|error|denied|unauthorized|forbidden)\b/gi) || []).length;
  const negativePathCoverage = stepLabels.length === 0 ? 0 : Math.min(100, negativePathSignals > 0 ? pct(Math.min(negativePathSignals, stepLabels.length), stepLabels.length, 0) || 25 : 0);

  const breakdown = { locatorStability, assertions, asyncHandling, bddStructure, negativePathCoverage };
  // negativePathCoverage deliberately excluded from `overall` — it's a
  // coverage-completeness signal (does this test check failure paths at
  // all), not a maintainability signal like the other four, and mixing the
  // two would make a thorough happy-path-only test score identically to an
  // actually worse one just because it exercises more error states. Shown
  // separately in the UI instead.
  const overall = Math.round((locatorStability + assertions + asyncHandling + bddStructure) / 4);

  return { overall, breakdown };
}
