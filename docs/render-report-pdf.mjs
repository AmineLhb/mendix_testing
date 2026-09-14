// Regenerates docs/mendix-test-agent-report.pdf from docs/report.html —
// run this again after editing report.html (e.g. once new features land)
// to refresh the PDF. Usage: node docs/render-report-pdf.mjs
import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = path.resolve('docs/report.html');
const outPath = path.resolve('docs/mendix-test-agent-report.pdf');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });

// Wait for every mermaid diagram to actually finish rendering into SVG.
await page.waitForFunction(() => {
  const diagrams = document.querySelectorAll('.mermaid');
  if (diagrams.length === 0) return false;
  return Array.from(diagrams).every((d) => d.querySelector('svg'));
}, { timeout: 30000 });

await page.pdf({
  path: outPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
});

await browser.close();
console.log('Wrote', outPath);
