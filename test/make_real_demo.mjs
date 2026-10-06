// Builds the real-video demo session (Milwaukee Highland Games 2014, CC BY) through the app:
// analyze the static-camera stretch around release, auto-track, then “Save markings”.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('dialog', async (d) => { console.log('[dialog]', d.message()); await d.dismiss(); });
await page.goto('http://localhost:5199/');
await page.setInputFiles('#file', new URL('../public/demo/milwaukee-2014.mp4', import.meta.url).pathname);
await page.waitForSelector('#analyze:not([disabled])', { timeout: 30000 });
await page.evaluate(() => {
  Object.assign(window.__app.setup, {
    timeScale: 0.25, // ~120 fps slow-mo played at 30; gravity agrees (see README)
    scaleMode: 'height', throwerHeight: 1.8, hfovDeg: 50, hand: 'unknown', hammerIndex: 6, psiMode: 'auto',
  });
  document.getElementById('t-start').value = '50.3';
  document.getElementById('t-end').value = '51.95';
});
await page.click('#analyze');
await page.waitForSelector('#busy', { state: 'hidden', timeout: 300000 });
await page.waitForTimeout(500);
const r = await page.evaluate(() => { const r = window.__app.result; return r.error ?? { n: window.__app.track.length, v: r.speed, ang: r.angle, h: r.height, psi: r.psi, dist: r.distDrag, unc: r.unc.dist, depth: r.depth, drift: r.cameraDrift, gd: r.gravityDepth, warn: r.warnings }; });
console.log(JSON.stringify(r));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save-session')]);
const out = new URL('../public/demo/milwaukee-2014.session.json', import.meta.url).pathname;
await dl.saveAs(out);
const s = JSON.parse(readFileSync(out, 'utf8'));
s.title = 'Milwaukee Highland Games 2014';
writeFileSync(out, JSON.stringify(s));
console.log('saved', (readFileSync(out).length / 1024).toFixed(0), 'KB');
await page.screenshot({ path: (process.env.OUT ?? '.') + '/real-demo.png', fullPage: true });
await browser.close();
