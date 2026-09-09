// Minimal raw recording used for CI dry-run enrich validation.
// This file intentionally contains only a goto to the app base URL.
await page.goto(process.env.BASE_URL || 'http://localhost:8080');
