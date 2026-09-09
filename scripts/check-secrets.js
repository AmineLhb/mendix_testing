/**
 * Hardcoded-secret detection for generated test text — shared by
 * scripts/validate-generated-tests.js (checks files already on disk under
 * generated-tests/, runs in pre-commit/CI) and ui/server.js's pending-
 * approval endpoint (checks a proposed test's text BEFORE it's written,
 * so a proposal that fails this check never touches generated-tests/ at
 * all rather than being written then rolled back).
 */

const EMAIL_RE = /["'`]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["'`]/g;
// Anchored to a password-ish identifier immediately followed by an assignment
// or a .fill(/.type( call, with the literal right there — NOT just "password"
// and any quoted string anywhere on the line. The looser version flagged
// false positives like `basePage.mx('textBox2').fill(process.env.MENDIX_TEST_PASSWORD ?? '')`
// (the widget-name literal earlier in the line has nothing to do with the
// actual password, which correctly comes from process.env) and
// `const passwordField = basePage.mx('textBox2');` (a variable name, not a value).
const PASSWORD_LITERAL_RE = /(password|pwd|passwd)\w*\s*(=|:|\.fill\(|\.type\()\s*["'`][^"'`]{2,}["'`]/i;

/** Returns an array of problems (empty = clean) for a single test's source text. */
export function checkTextForSecrets(text) {
  const problems = [];

  const emails = Array.from(text.matchAll(EMAIL_RE), (m) => m[1]);
  if (emails.length) problems.push({ reason: "hardcoded emails", details: emails });

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (PASSWORD_LITERAL_RE.test(l)) {
      problems.push({ reason: "possible hardcoded password", line: i + 1, snippet: l.trim() });
      break;
    }
  }

  return problems;
}
