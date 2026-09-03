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
}
