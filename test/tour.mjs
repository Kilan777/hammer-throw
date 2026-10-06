// Smoke test: open a demo from the menu (should be instant, pre-marked), then click through the tutorial.
//   OUT=<dir> node test/tour.mjs
import { chromium } from 'playwright-core';
const OUT = process.env.OUT;
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('dialog', async (d) => { console.log('[dialog]', d.message()); await d.dismiss(); });
await page.goto('http://localhost:5199/');
await page.screenshot({ path: `${OUT}/t-landing.png` });
// Demo via menu
const t0 = Date.now();
await page.click('#demo');
await page.screenshot({ path: `${OUT}/t-menu.png`, clip: { x: 900, y: 0, width: 540, height: 260 } });
await page.click('#demo-menu button >> nth=0');
await page.waitForSelector('#result-card:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(800);
console.log('demo ready in', ((Date.now() - t0) / 1000).toFixed(1), 's', await page.evaluate(() => ({ d: window.__app.result.distDrag.toFixed(2), ref: document.getElementById('r-ref').textContent, retrackDisabled: document.getElementById('retrack').disabled })));
// Tour
await page.click('#tour');
for (let i = 0; i < 11; i++) {
  await page.waitForTimeout(450);
  const info = await page.evaluate(() => ({ step: document.querySelector('.tour-step')?.textContent, title: document.querySelector('.tour-card h3')?.textContent, card: (() => { const r = document.querySelector('.tour-card').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(), spot: document.querySelector('.tour-spot').hidden ? null : (() => { const r = document.querySelector('.tour-spot').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() }));
  console.log(JSON.stringify(info));
  await page.screenshot({ path: `${OUT}/t-step${i + 1}.png` });
  await page.click('.tour-card [data-act="next"]');
}
console.log('tour closed:', await page.evaluate(() => !document.querySelector('.tour-root')));
await browser.close();
