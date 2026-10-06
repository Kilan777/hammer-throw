// “Calibrate from circle”: every hammer circle is a known 2.135 m calibration target.
// From the horizon (→ camera tilt) and the circle's left/right/near/far edges in the image, solve
// the camera's focal length, height above the ground and the circle centre's position.

import { CIRCLE_RADIUS } from './analyze';
import { levelPx, levenberg, project, type Cam } from './fit3d';

export interface CalibClicks {
  horizon: { x: number; y: number };
  left: { x: number; y: number };
  right: { x: number; y: number };
  near: { x: number; y: number }; // bottom of the ellipse (closest to camera)
  far: { x: number; y: number }; // top of the ellipse
}

export interface CalibResult {
  hfovDeg: number;
  pitchDeg: number;
  H: number; // camera height above ground (m)
  C: { x: number; z: number }; // circle centre, level world frame (m)
  distance: number; // horizontal camera → circle centre (m)
  rmsPx: number;
}

const N = 720;

/** Extreme points (left, right, near/bottom, far/top) of the projected circle, as seen in the
 * raw image — that's what people click, and for a flat ellipse under roll it differs from the
 * extremes in roll-corrected coordinates. */
function extremes(cam: Cam, H: number, Cx: number, Cz: number) {
  let L = { x: Infinity, y: 0 }, Rr = { x: -Infinity, y: 0 }, Nn = { x: 0, y: -Infinity }, F = { x: 0, y: Infinity };
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    const q = project(cam, Cx + CIRCLE_RADIUS * Math.cos(a), H, Cz + CIRCLE_RADIUS * Math.sin(a));
    if (q.x < L.x) L = q;
    if (q.x > Rr.x) Rr = q;
    if (q.y > Nn.y) Nn = q;
    if (q.y < F.y) F = q;
  }
  return [L, Rr, Nn, F];
}

export function calibrateFromCircle(k: CalibClicks, W: number, Himg: number, roll: number): CalibResult {
  const base: Cam = { f: 1, cx: W / 2, cy: Himg / 2, cos: Math.cos(roll), sin: Math.sin(roll) };
  const lv = (p: { x: number; y: number }) => levelPx(base, p.x, p.y);
  const hz = lv(k.horizon);
  const obs = [k.left, k.right, k.near, k.far];
  const w = obs[1].x - obs[0].x;
  const h = obs[2].y - obs[3].y;
  if (w < 10 || h < 2) throw new Error('Those circle clicks are too close together — click the left, right, nearest and farthest points of the circle.');
  if ((obs[2].y + obs[3].y) / 2 <= hz.y) throw new Error('The horizon must be above the circle.');

  // Small-angle starting guess: width ∝ f/D, height/width ≈ H/D, drop below horizon ≈ f·H/D.
  const r2 = 2 * CIRCLE_RADIUS;
  const yc = (obs[2].y + obs[3].y) / 2, xc = (obs[0].x + obs[1].x) / 2;
  const H0 = ((yc - hz.y) * r2) / w;
  const D0 = (H0 * w) / h;
  const f0 = (D0 * w) / r2;
  // Parameters: log f, log H, Cx, Cz. Pitch follows from f and the horizon.
  const camFor = (p: number[]): Cam => {
    const f = Math.exp(p[0]);
    return { ...base, f, pitch: Math.atan((base.cy - hz.y) / f) };
  };
  const resid = (p: number[]) => {
    const cam = camFor(p);
    const ex = extremes(cam, Math.exp(p[1]), p[2], p[3]);
    const r: number[] = [];
    ex.forEach((q, i) => r.push(q.x - obs[i].x, q.y - obs[i].y));
    return r;
  };
  // A few starting depths: the small-angle guess can be well off for flat (far/low) views.
  let best: { p: number[]; r: number[]; cost: number } | null = null;
  for (const k0 of [1, 0.7, 1.4, 0.5, 2]) {
    const D = D0 * k0, f = (D * w) / r2, Hh = (h / w) * D;
    const run = levenberg(resid, [Math.log(f), Math.log(Hh), ((xc - base.cx) * D) / f, D], 200);
    if (!best || run.cost < best.cost) best = run;
  }
  const { p, r } = best!;
  const cam = camFor(p);
  const C = { x: p[2], z: p[3] };
  return {
    hfovDeg: (2 * Math.atan(W / 2 / cam.f) * 180) / Math.PI,
    pitchDeg: ((cam.pitch ?? 0) * 180) / Math.PI,
    H: Math.exp(p[1]),
    C,
    distance: Math.hypot(C.x, C.z),
    rmsPx: Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length),
  };
}

/** The calibrated circle as an image polyline (for drawing a check overlay). */
export function circleOutline(cam: Cam, H: number, C: { x: number; z: number }, n = 96) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push(project(cam, C.x + CIRCLE_RADIUS * Math.cos(a), H, C.z + CIRCLE_RADIUS * Math.sin(a)));
  }
  return pts;
}
