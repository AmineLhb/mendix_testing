module.exports = {
  // browser: true because several files pass callbacks to page.evaluate() —
  // those run inside the browser (window/document/etc.), not Node.
  env: { node: true, browser: true, es2021: true },
  extends: ['eslint:recommended'],
  // 'latest' (not 2021) so top-level await parses — several scripts here
  // (enrich.js, dump-widgets.js, autonomous-agent.js) use it at module scope.
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  ignorePatterns: [
    'node_modules/',
    'playwright-report/',
    'test-results/',
    'projects/**/playwright-report/',
    'projects/**/test-results/',
    // Raw codegen recordings/fragments — not self-contained JS, not meant to lint.
    'explorer/raw-*.spec.js',
    'projects/**/explorer/raw-*.spec.js',
  ],
  rules: {
    'no-unused-vars': ['warn'],
    'no-console': 'off'
  }
};
