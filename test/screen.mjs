// Screens videos for a visible ballistic flight: motion candidates + the app's arc tracker over
// sliding windows, with loose limits (unknown scale and slow-motion factor).
//   node test/screen.mjs /_scr/a.mp4 /_scr/b.mp4 ...
import { chromium } from 'playwright-core';
const urls = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/bin/google-chrome', headless: true });
for (const url of urls) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5199/');
  const res = await page.evaluate(async (url) => {
    const { detectCandidates, DEFAULT_MOTION } = await import('/src/motion.ts');
    const { findTrack } = await import('/src/track.ts');
    const v = document.createElement('video'); v.muted = true; v.src = url; v.preload = 'auto';
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; });
    const W = 320, H = Math.round((W * v.videoHeight) / v.videoWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    const fps = 30, dur = Math.min(v.duration, 140), n = Math.floor(dur * fps);
    const grays = [], ts = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = (i + 0.5) / fps; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      g.drawImage(v, 0, 0, W, H); const d = g.getImageData(0, 0, W, H).data; const gr = new Uint8Array(W * H);
      for (let k = 0, j = 0; j < gr.length; k += 4, j++) gr[j] = (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8;
      grays.push(gr); ts.push(i / fps);
    }
    const cands = grays.map((_, i) => (i === 0 || i === n - 1 ? [] : detectCandidates(grays[i - 1], grays[i], grays[i + 1], W, H, [], DEFAULT_MOTION)));
    const out = [];
    for (let s = 0; s + 20 < n; s += 30) {
      const fr = []; for (let i = s; i < Math.min(n, s + 75); i++) fr.push({ frame: i, t: ts[i], cands: cands[i], body: null });
      const tr = findTrack(fr, { W, H, fps, ppm: null, iterations: 2500, override: { vMin: 0.08 * W, vMax: 3 * W * fps, aMin: 1, aMax: 1e9 } });
      if (tr.length >= 5) {
        const span = Math.hypot(tr[tr.length - 1].x - tr[0].x, tr[tr.length - 1].y - tr[0].y);
        out.push({ n: tr.length, t0: +tr[0].t.toFixed(2), t1: +tr[tr.length - 1].t.toFixed(2), span: Math.round(span), y0: Math.round(tr[0].y), y1: Math.round(tr[tr.length - 1].y) });
      }
    }
    out.sort((a, b) => b.n * b.span - a.n * a.span);
    return { dur: v.duration, size: `${v.videoWidth}x${v.videoHeight}`, top: out.slice(0, 4) };
  }, url);
  console.log(url.split('/').pop(), res.size, `${Math.round(res.dur)}s`, JSON.stringify(res.top));
  await page.close();
}
await browser.close();
