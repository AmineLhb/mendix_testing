/**
 * Derives a Gherkin .feature doc from a Playwright spec's test.step() labels.
 *
 * The .spec.js file (and its test.step('Given/When/Then ...', ...) calls) is
 * the single source of truth — it's what actually runs, and Playwright's own
 * HTML report already renders those steps as an expandable per-test tree. The
 * .feature file is mechanically derived FROM that source, never hand-edited
 * independently, so the two can never drift apart. Edit the test.step()
 * labels in the .spec.js, then re-derive (enrich.js does this automatically
 * for newly generated tests; `npm run features:sync` re-derives for any spec
 * you hand-edited afterward).
 */

const TEST_DESCRIBE_RE = /\btest\.describe\(\s*['"`]([^'"`]+)['"`]/;
const TEST_RE = /\btest\(\s*['"`]([^'"`]+)['"`]/g;
const STEP_RE = /\btest\.step\(\s*['"`]([^'"`]+)['"`]/g;

export function deriveFeatureText(specText, fallbackTitle) {
  const describeMatch = specText.match(TEST_DESCRIBE_RE);
  const featureTitle = describeMatch ? describeMatch[1] : fallbackTitle;

  const tests = [...specText.matchAll(TEST_RE)].map((m) => ({ title: m[1], index: m.index }));
  const steps = [...specText.matchAll(STEP_RE)].map((m) => ({ text: m[1], index: m.index }));

  if (tests.length === 0) return null;

  const lines = [
    `# Auto-derived from the test.step() labels in the matching .spec.js file.`,
    `# Do not hand-edit — edit the test.step() calls there and re-derive instead`,
    `# (enrich.js does this automatically; run "npm run features:sync" after`,
    `# hand-editing a spec's steps directly).`,
    ``,
    `Feature: ${featureTitle}`,
    ``,
  ];

  tests.forEach((t, i) => {
    const nextIndex = i + 1 < tests.length ? tests[i + 1].index : Infinity;
    const ownSteps = steps
      .filter((s) => s.index > t.index && s.index < nextIndex)
      .map((s) => s.text);

    lines.push(`  Scenario: ${t.title}`);
    if (ownSteps.length === 0) {
      lines.push(`    # (no test.step() calls found in this test yet)`);
    } else {
      for (const s of ownSteps) lines.push(`    ${s}`);
    }
    lines.push(``);
  });

  return lines.join('\n').trimEnd() + '\n';
}

export function featurePathFor(specPath) {
  return specPath.replace(/\.spec\.js$/, '.feature');
}
