// Dumps per-frame motion candidates for a demo scene, so the tracker/fit can be iterated offline.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const demo = process.env.DEMO ?? 'throw';
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await page.goto(`http://localhost:5199/?demo=${demo}`);
await page.evaluate(() => window.__api.openDemo());
await page.waitForSelector('#result-card:not([hidden])', { timeout: 30000 });
await page.waitForSelector('#analyze:not([disabled])');
await page.click('#analyze');
await page.waitForSelector('#busy', { state: 'hidden', timeout: 180000 });
const data = await page.evaluate(() => {
  const a = window.__app;
  return { W: a.W, H: a.H, fps: a.fps, frames: a.frames.map((f) => ({ frame: f.frame, t: f.t, pose: f.pose, cands: f.cands })) };
});
writeFileSync(process.env.OUT ?? `cands-${demo}.json`, JSON.stringify(data));
await browser.close();
