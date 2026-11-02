// Usage: node scripts/shot.mjs <url-query> <outdir> <script.js>
// Loads the game in headless Chromium, runs the steps exported by script.js,
// and prints console errors. Each step: { wait?: ms, eval?: string, shot?: name }
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
import path from 'node:path';

const [, , query = '', outDir = 'shots', stepsFile] = process.argv;
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ wait: 3000 }, { shot: 'default' }];
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  else if (process.env.VERBOSE) console.log('[log]', m.text());
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:5173/${query}`);
for (const s of steps) {
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.eval) {
    const r = await page.evaluate(s.eval);
    if (r !== undefined) console.log('eval:', JSON.stringify(r));
  }
  if (s.waitFor) await page.waitForFunction(s.waitFor, null, { timeout: s.timeout ?? 30000, polling: 50 });
  if (s.shot) {
    await page.evaluate(() => { const g = window.__court; if (g && g.holdRender) g.renderNow(); });
    await page.screenshot({ path: path.join(outDir, s.shot + '.png') });
    console.log('shot', s.shot);
  }
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
