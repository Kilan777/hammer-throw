// Builds the pre-marked demo sessions: analyze each synthetic demo in headless Chrome, add the
// thrower position (MediaPipe can't see the cartoon figure) + ground line + known answer, then
// save markings via the app's own “Save markings” button into public/demo/<id>.session.json.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['throw', 'square'];
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
for (const id of ids) {
  const info = JSON.parse(readFileSync(new URL(`../public/demo/${id}.json`, import.meta.url)));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:5199/?demo=${id}`);
  await page.evaluate(() => window.__api.openDemo());
  await page.waitForSelector('#analyze:not([disabled])');
  await page.evaluate((setup) => Object.assign(window.__app.setup, setup), info.setup);
  await page.click('#analyze');
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 180000 });
  await page.waitForTimeout(300);
  await page.evaluate(({ T, D }) => {
    const a = window.__app;
    const gy = (T.groundY / 720) * a.H;
    const hip = { x: (430 / 1280) * a.W, y: ((T.groundY - 0.95 * (1004.6 / D)) / 720) * a.H, v: 1 };
    for (const f of a.frames) f.pose = Array.from({ length: 33 }, (_, i) => (i === 23 || i === 24 ? { ...hip } : { x: 0, y: 0, v: 0 }));
    a.setup.groundLine = { x1: 0, y1: gy, x2: a.W, y2: gy };
    a.reference = { distance: Math.round(T.rangeDrag * 100) / 100, label: 'synthetic truth' };
    a.setup.releaseFrame = null;
    window.__api.recompute();
  }, { T: info.truth, D: info.setup.cameraDistance });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save-session')]);
  const path = new URL(`../public/demo/${id}.session.json`, import.meta.url).pathname;
  await dl.saveAs(path);
  const s = JSON.parse(readFileSync(path, 'utf8'));
  s.title = info.title ?? id;
  writeFileSync(path, JSON.stringify(s));
  const r = await page.evaluate(() => { const r = window.__app.result; return { d: r.distDrag, psi: r.psi, n: window.__app.track.length }; });
  console.log(id, 'saved', path.split('/').pop(), `${(readFileSync(path).length / 1024).toFixed(0)} KB`, JSON.stringify(r));
  await page.close();
}
await browser.close();
