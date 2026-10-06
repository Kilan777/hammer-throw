// Extract frames from a video via headless Chrome (decodes what the browser decodes) as JPEGs.
//   node test/extract_frames.mjs <url-path-under-public> <outDir> <t0> <t1> <step> <width>
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
const [src, outDir, t0, t1, step, width] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
const frames = await page.evaluate(async ({ src, t0, t1, step, width }) => {
  const v = document.createElement('video'); v.muted = true; v.src = src; v.preload = 'auto';
  await new Promise((r) => (v.onloadeddata = r));
  const W = +width, H = Math.round(W * v.videoHeight / v.videoWidth);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const out = [];
  for (let t = +t0; t <= Math.min(+t1, v.duration); t += +step) {
    v.currentTime = t; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    g.drawImage(v, 0, 0, W, H); out.push([t, c.toDataURL('image/jpeg', 0.85)]);
  }
  return { out, dur: v.duration, vw: v.videoWidth, vh: v.videoHeight };
}, { src, t0, t1, step, width });
frames.out.forEach(([t, d], i) => writeFileSync(`${outDir}/f${String(i).padStart(4, '0')}_${(+t).toFixed(3)}.jpg`, Buffer.from(d.split(',')[1], 'base64')));
console.log('duration', frames.dur, frames.vw, frames.vh, 'frames', frames.out.length);
await browser.close();
