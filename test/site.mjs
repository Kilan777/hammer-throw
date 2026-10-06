// Smoke test of a built/deployed site: real demo, re-analysis (pose model + wasm), tutorial.
//   BASE=https://kilan777.github.io/hammer-throw/ node test/site.mjs
import { chromium } from 'playwright-core';
const base = process.env.BASE;
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const bad = [];
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (['error','warning'].includes(m.type()) && !/GL Driver|gl_context|landmark_proj|GPU stall/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
page.on('dialog', async (d) => { console.log('[dialog]', d.message()); await d.dismiss(); });
await page.goto(base);
await page.click('#demo'); await page.click('#demo-menu button >> nth=0');
await page.waitForSelector('#result-card:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(800);
console.log('real demo:', await page.evaluate(() => document.getElementById('r-dist').textContent), 'm');
// Re-run detection on the real demo to prove the pose model + wasm load from this base path.
await page.click('#analyze');
await page.waitForSelector('#busy', { state: 'hidden', timeout: 300000 });
await page.waitForTimeout(500);
console.log('re-analyzed:', JSON.stringify(await page.evaluate(() => ({ frames: window.__app.frames.length, range: window.__app.range, err: window.__app.result?.error, ts: window.__app.setup.timeScale, start: document.getElementById('t-start').value, end: document.getElementById('t-end').value, dist: document.getElementById('r-dist').textContent, poses: window.__app.frames.filter((f) => f.pose).length, n: window.__app.track.length }))));
await page.click('#tour');
for (let i = 0; i < 11; i++) { await page.waitForTimeout(250); await page.click('.tour-card [data-act="next"]'); }
console.log('tour ok:', await page.evaluate(() => !document.querySelector('.tour-root')));
console.log('failed requests:', bad.length ? bad.join('\n') : 'none');
await browser.close();
