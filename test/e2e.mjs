// End-to-end check: load the synthetic demo in headless Chrome, analyze, compare with ground truth.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const demo = process.env.DEMO ?? 'throw';
const url = `${process.env.URL ?? 'http://localhost:5199/'}?demo=${demo}`;
const out = process.env.OUT ?? '.';
const truth = JSON.parse(readFileSync(new URL(`../public/demo/${demo}.json`, import.meta.url))).truth;

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.click('#demo2');
await page.waitForSelector('#analyze:not([disabled])', { timeout: 30000 });
const fps = await page.evaluate(() => window.__app.fps);
console.log('detected fps', fps);
const t0 = Date.now();
await page.click('#analyze');
await page.waitForSelector('#result-card:not([hidden])', { timeout: 180000 });
await page.waitForSelector('#busy', { state: 'hidden', timeout: 180000 });
await page.waitForTimeout(500);
// The synthetic figure is too crude for MediaPipe: emulate a detected thrower (hips at the axis).
if (process.env.FAKE_POSE !== '0') {
  await page.evaluate(({ gy, D }) => {
    const a = window.__app;
    const hip = { x: 430 / 2, y: (gy - 0.95 * (1004.6 / D)) / 2, v: 1 };
    for (const f of a.frames) f.pose = Array.from({ length: 33 }, (_, i) => (i === 23 || i === 24 ? { ...hip } : { x: 0, y: 0, v: 0 }));
  }, { gy: truth.groundY, D: 10 });
}
// Set the ground line by clicking it (no feet in the emulated pose).
if (process.env.SET_GROUND !== '0') {
  await page.click('[data-tool="ground"]');
  const box = await page.locator('#canvas').boundingBox();
  const gy = box.y + (truth.groundY / 720) * box.height;
  await page.mouse.click(box.x + box.width * 0.1, gy);
  await page.mouse.click(box.x + box.width * 0.9, gy);
  await page.waitForTimeout(1000);
}
console.log('analysis took', ((Date.now() - t0) / 1000).toFixed(1), 's');

const r = await page.evaluate(() => {
  const a = window.__app;
  const r = a.result;
  return {
    nFrames: a.frames.length,
    withPose: a.frames.filter((f) => f.pose).length,
    track: a.track.map((p) => [p.frame, +p.t.toFixed(3), +p.x.toFixed(1), +p.y.toFixed(1)]),
    error: r?.error,
    speed: r?.speed, angle: r?.angle, height: r?.height, psi: r?.psi, lateral: r?.lateral, depth: r?.depth,
    gravityDepth: r?.gravityDepth, camHeight: r?.geo?.camHeight, rms: r?.fit?.rmsPx,
    distDrag: r?.distDrag, distVac: r?.distVac, unc: r?.unc,
    releaseFrame: r?.releaseFrame, releaseT: r?.releaseT, warnings: r?.warnings,
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${out}/e2e-${demo}.png`, fullPage: true });

if (!r.error) {
  const cmp = (k, got, want) => console.log(`${k.padEnd(10)} got ${got.toFixed(2).padStart(7)}  truth ${want.toFixed(2).padStart(7)}  err ${(got - want).toFixed(2)}`);
  cmp('speed', r.speed, truth.speed);
  cmp('angle', r.angle, truth.angle);
  cmp('height', r.height, truth.height);
  cmp('psi', r.psi, truth.psi);
  cmp('lateral', r.lateral, truth.lateral);
  cmp('depth', r.depth, truth.releaseDepth);
  cmp('camHeight', r.camHeight, truth.camHeight);
  cmp('distDrag', r.distDrag, truth.rangeDrag);
  cmp('distVac', r.distVac, truth.rangeVac);
}

// Right-to-left throw: mirror the track + ground, numbers should be identical.
const mir = await page.evaluate(() => {
  const a = window.__app, W = a.W;
  a.saved = { track: a.track, ground: a.setup.groundLine, poses: a.frames.map((f) => f.pose) };
  a.track = a.track.map((p) => ({ ...p, x: W - p.x }));
  for (const f of a.frames) f.pose = f.pose && f.pose.map((l) => ({ ...l, x: W - l.x }));
  const g = a.setup.groundLine;
  a.setup.groundLine = { x1: W - g.x2, y1: g.y2, x2: W - g.x1, y2: g.y1 };
  a.saved.hand = a.setup.hand;
  a.setup.hand = a.setup.hand === 'right' ? 'left' : 'right'; // a mirrored right-hander is a left-hander
  window.__api.recompute();
  const r = a.result;
  const out = r.error ? { error: r.error } : { speed: r.speed, angle: r.angle, height: r.height, psi: r.psi, lateral: r.lateral, dist: r.distDrag, dir: r.dir };
  a.setup.scaleMode = 'gravity';
  window.__api.recompute();
  const rg = a.result;
  out.gravity = rg.error ?? { dist: rg.distDrag, depth: rg.depth, warnings: rg.warnings };
  a.setup.scaleMode = 'camera';
  a.setup.hand = a.saved.hand;
  a.frames.forEach((f, i) => (f.pose = a.saved.poses[i]));
  window.__api.recompute();
  return out;
});
console.log('mirrored', JSON.stringify(mir));
await page.locator('.canvas-wrap').screenshot({ path: `${out}/e2e-mirrored.png` });

// Manual workflow: clear all points, then click the ball in 4 frames with the Mark ball tool.
const pts = await page.evaluate(() => {
  const a = window.__app;
  a.track = [];
  a.setup.groundLine = a.saved.ground;
  window.__api.recompute();
  return a.saved.track.filter((p) => p.frame >= 51 && p.frame <= 54);
});
await page.evaluate(() => window.__api.showFrame(51));
await page.waitForTimeout(300);
await page.click('[data-tool="ball"]');
const box = await page.locator('#canvas').boundingBox();
const W = await page.evaluate(() => window.__app.W), H = await page.evaluate(() => window.__app.H);
for (const p of pts) {
  await page.mouse.click(box.x + (p.x / W) * box.width, box.y + (p.y / H) * box.height);
  await page.waitForTimeout(300);
}
await page.keyboard.press('Escape');
const man = await page.evaluate(() => { const r = window.__app.result; return r.error ?? { n: window.__app.track.length, manual: window.__app.track.every((p) => p.manual), speed: r.speed, angle: r.angle, dist: r.distDrag, rel: r.releaseFrame }; });
console.log('manual', JSON.stringify(man));
await page.screenshot({ path: `${out}/e2e-manual.png`, fullPage: true });
await browser.close();
