// Offline: run tracker + analysis on dumped candidates and compare with ground truth.
//   node test/harness.mjs <cands.json> <demo name>
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
const [candsPath, demo] = process.argv.slice(2);
const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent' });
const { findTrack } = await server.ssrLoadModule('/src/track.ts');
const { analyze, cameraPpm, DEFAULT_SETUP } = await server.ssrLoadModule('/src/analyze.ts');
const { bodyCenter } = await server.ssrLoadModule('/src/pose.ts');
const d = JSON.parse(readFileSync(candsPath, 'utf8'));
const info = JSON.parse(readFileSync(new URL(`../public/demo/${demo}.json`, import.meta.url)));
const setup = { ...DEFAULT_SETUP, ...info.setup };
// FAKE_POSE=1 emulates a detected thrower: hips at the axis (the synthetic figure is too crude
// for MediaPipe to find).
if (process.env.FAKE_POSE === '1') {
  const hip = { x: 430 / 2, y: (info.truth.groundY - 0.95 * (1004.6 / (info.setup.cameraDistance))) / 2, v: 1 };
  for (const f of d.frames) f.pose = Array.from({ length: 33 }, (_, i) => (i === 23 || i === 24 ? { ...hip } : { x: 0, y: 0, v: 0 }));
}
const gy = (info.truth.groundY / 720) * d.H;
setup.groundLine = { x1: 0, y1: gy, x2: d.W, y2: gy };
const t0 = performance.now();
const track = findTrack(d.frames.map((f) => ({ frame: f.frame, t: f.t, cands: f.cands, body: bodyCenter(f.pose) })), { W: d.W, H: d.H, fps: d.fps, ppm: cameraPpm(d.W, setup) });
const t1 = performance.now();
console.log('track', track.map((p) => `${p.frame}:(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '), `[${(t1 - t0).toFixed(0)} ms]`);
const r = analyze(d.frames, track, setup, d.W, d.H);
if (r.error) console.log('ERROR', r.error);
else {
  const T = info.truth;
  for (const [k, got, want] of [['speed', r.speed, T.speed], ['angle', r.angle, T.angle], ['height', r.height, T.height], ['psi', r.psi, T.psi], ['lateral', r.lateral, T.lateral], ['depth', r.depth, T.releaseDepth], ['distDrag', r.distDrag, T.rangeDrag]])
    console.log(`${k.padEnd(9)} ${got.toFixed(2).padStart(7)}  truth ${want.toFixed(2).padStart(7)}  err ${(got - want).toFixed(2).padStart(6)}  ${r.unc[k === 'distDrag' ? 'dist' : k] !== undefined ? '±' + r.unc[k === 'distDrag' ? 'dist' : k].toFixed(2) : ''}`);
  console.log('warnings', r.warnings, 'rms', r.fit.rmsPx.toFixed(2), 'excluded', r.excluded);
}
await server.close();
