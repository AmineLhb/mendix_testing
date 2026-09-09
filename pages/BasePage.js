/**
 * BasePage — shared helpers for every Mendix page object.
 *
 * Centralizing the mx-name-* locator logic and the "wait for the app to
 * settle" logic here means the generated test files stay short and
 * readable, and if Mendix changes something about loading indicators
 * across a platform upgrade, you only fix it in one place.
 */
export class BasePage {
  constructor(page) {
    this.page = page;
  }

  /**
   * Locate a widget by the Name you gave it in Studio Pro.
   * e.g. mx('btnSubmitOrder') -> page.locator('.mx-name-btnSubmitOrder')
   *
   * Verified against the real app on 2026-08-11: Mendix (Atlas UI, this
   * theme) puts the mx-name-* class on the widget's outer wrapper <div>,
   * not on the actual <input>/<textarea>/<select> inside it — e.g.
   * `<div class="mx-name-textBox1 ...">` wraps a plain `<input>`. Calling
   * .fill() on the wrapper fails ("not an <input>..."). This selector
   * resolves to the nested field when one exists, and to the wrapper
   * itself otherwise (buttons, containers, links, etc.), so mx() works
   * for both .click() and .fill()/.selectOption() without callers having
   * to know which case they're in.
   */
  mx(widgetName) {
    const base = `.mx-name-${widgetName}`;
    return this.page.locator(
      `${base} input, ${base} textarea, ${base} select, ` +
        `${base}:not(:has(input)):not(:has(textarea)):not(:has(select))`
    );
  }

  /**
   * Mendix runs most user actions (button clicks, save, navigation) as a
   * microflow call to the server. Racing your next assertion against that
   * call is the #1 cause of flaky Mendix tests.
   *
   * Verified against this project's actual app (Mendix 10.24.2, custom
   * Atlas-based theme) on 2026-08-11: it renders no full-page loading
   * overlay at all — DOM mutation observation and screenshots under 2.5s
   * artificial network latency across login and several concurrent
   * microflow calls showed no mx-loading-overlay/modal-loading/spinner
   * element ever appearing. `networkidle` was confirmed to resolve
   * correctly (the app's dev-tools WebSocket at ws://localhost:8080/mxdevtools/
   * does not block it), so it's the primary and only signal here.
   *
   * The overlay check below is kept as a cheap opportunistic fast-path for
   * OTHER Mendix apps/themes that do render one — it has a short timeout
   * so it doesn't add latency when (as in this app) no overlay ever shows.
   * If you're porting this to a different Mendix app, re-verify with
   * explorer/inspect-loading-selector.js before trusting LOADING_SELECTOR.
   */
  async waitForMendixIdle(timeout = 15000) {
    const LOADING_SELECTOR = '.mx-loading-overlay, .modal-loading, .glyphicon-refresh';
    try {
      await this.page.locator(LOADING_SELECTOR).first().waitFor({ state: 'visible', timeout: 300 });
      await this.page.locator(LOADING_SELECTOR).first().waitFor({ state: 'hidden', timeout });
    } catch {
      // No loading indicator appeared at all (action was instant/client-side, or this
      // app doesn't use one) — that's fine, networkidle below is the real signal.
    }
    await this.page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  }

  /** Mendix's standard error toast/popup, useful for a blanket "nothing broke" assertion. */
  async expectNoErrorMessage() {
    const errorPopup = this.page.locator('.mx-error, .modal-error, .alert-danger');
    await this.page.waitForTimeout(200); // let a would-be error render
    if (await errorPopup.count()) {
      const text = await errorPopup.first().innerText();
      throw new Error(`Mendix error message appeared: ${text}`);
    }
  }

  /**
   * Log out via the icon-only logout button in the top bar. Verified
   * 2026-09-04: after clicking, the login form reappears — confirms the
   * server-side session actually ends, not just a client-side navigation.
   *
   * The button's mx-name (actionButton2) is NOT unique on the list page —
   * every row's "Modifier" (edit) button shares the same default name (the
   * same unrenamed-widget collision seen elsewhere in this app), so
   * mx('actionButton2') throws a strict-mode violation once any rows exist.
   * Mendix adds an extra semantic `logout` class to this specific button
   * though, so target that directly instead of going through mx().
   *
   * Call this at the end of every test that logs in. The local Studio Pro
   * dev license caps concurrent signed-in sessions, and without an explicit
   * logout, each test's session sits active until it times out on its own —
   * enough test runs in a row exhausts the seat limit (see README "Known
   * issue" section). Logging out frees the seat immediately instead.
   */
  async logout() {
    await this.page.locator('.mx-name-actionButton2.logout').click();
    await this.waitForMendixIdle();
  }

  /**
   * Capture the actual /xas/ API response produced by a Mendix action (a
   * click, a fill that triggers on-change, etc.), instead of only checking
   * what rendered in the DOM afterward.
   *
   * Verified against the real app on 2026-09-04 (explorer/inspect-api-responses.js):
   * every user action goes through POST /xas/, and a single click can trigger
   * MULTIPLE /xas/ calls in sequence (e.g. login itself returns almost nothing,
   * then a separate get_session_data call follows with the real `roles`/`user`
   * payload). Matching on URL alone often grabs the wrong one, so `matchBody`
   * lets you wait for the specific response you actually want by content.
   *
   * Usage:
   *   const { status, body } = await basePage.captureApiResponse(
   *     () => basePage.mx('actionButton1').click(),
   *     { matchBody: (b) => 'roles' in b }
   *   );
   */
  async captureApiResponse(triggerAction, { timeout = 15000, matchBody } = {}) {
    const responsePromise = this.page.waitForResponse(async (res) => {
      if (!res.url().includes('/xas/')) return false;
      if (!matchBody) return true;
      try {
        return matchBody(await res.json());
      } catch {
        return false;
      }
    }, { timeout });

    const [response] = await Promise.all([responsePromise, triggerAction()]);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status(), body, response };
  }

  /**
   * Assert an /xas/ API call actually succeeded. Gives a specific, actionable
   * message for 402 — verified on 2026-09-04 to be Mendix's status code for
   * "the current license does not allow more users to sign in" (the local
   * Studio Pro seat-limit issue — see README "Known issue" section) — instead
   * of a generic failure that looks like a locator/timing bug.
   */
  expectApiSuccess({ status, body }) {
    if (status === 402) {
      throw new Error(
        'API call failed with 402 — Mendix license seat limit reached. ' +
          'Restart the app in Studio Pro to free active sessions (see README "Known issue" section).'
      );
    }
    if (status < 200 || status >= 300) {
      throw new Error(`API call failed with status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  /** Find a persisted domain object of a given type in an /xas/ response body's `objects` array. */
  findApiObject(body, objectType) {
    return (body?.objects || []).find((o) => o.objectType === objectType) ?? null;
  }
}
