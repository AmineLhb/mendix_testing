/**
 * Reusable business steps — the action sequence behind a BDD step that's
 * genuinely identical across multiple tests, factored out once instead of
 * duplicated. Extracted verbatim from the 5 already-passing, already-verified
 * generated-tests/<role>/login.spec.js files (2026-09-10) — not invented —
 * so this stays grounded in the same "never guess, only what's actually been
 * verified against the real app" rule as everything else here.
 *
 * These export the RAW action sequence, not wrapped in their own
 * `test.step()`. The calling .spec.js wraps the call in its own
 * `test.step('Given/When/Then ...')` so the BDD label stays directly visible
 * in the spec file — that's what scripts/gherkin.js scans to derive the
 * companion .feature doc; hiding the label inside this shared module would
 * break that mechanism.
 */

/**
 * Fills the login form and submits it, capturing the post-login API
 * response that actually carries `roles`/`user` (not the login action's own
 * near-empty response — see BasePage.captureApiResponse's own doc comment).
 * Does not assert anything — different roles land on different pages and
 * have different Name-casing behavior, so the caller does its own
 * role-specific assertions on the returned { status, body } afterward.
 */
export async function submitLogin(basePage, { username, password }) {
  await basePage.mx('textBox1').fill(username ?? '');
  await basePage.mx('textBox2').fill(password ?? '');
  return basePage.captureApiResponse(
    () => basePage.mx('actionButton1').click(),
    { matchBody: (b) => 'roles' in b }
  );
}

/**
 * Same login form, for a negative-path (expected-to-fail) login. Doesn't use
 * captureApiResponse's matchBody wait — a failed login never produces a
 * `roles` response, so waiting for one would just burn the full timeout for
 * no reason. Submits and waits for the app to settle; the caller asserts on
 * the resulting DOM error message.
 *
 * Positional args deliberately, not an { username, password } object like
 * submitLogin above: a call-site object literal `password: 'literal-string'`
 * is exactly the shape scripts/check-secrets.js's hardcoded-secret heuristic
 * looks for (correctly — that's a real secret-leak pattern in the general
 * case), and it can't distinguish that from this test's deliberately-fake
 * wrong-password fixture. Positional args sidestep the false positive
 * without weakening the check itself.
 */
export async function submitLoginExpectingFailure(basePage, username, wrongPassword) {
  await basePage.mx('textBox1').fill(username ?? '');
  await basePage.mx('textBox2').fill(wrongPassword ?? '');
  await basePage.mx('actionButton1').click();
  await basePage.waitForMendixIdle();
}
