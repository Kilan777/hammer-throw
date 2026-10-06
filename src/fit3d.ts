// 3D ballistic fit through a pinhole camera.
//
// Instead of assuming the ball flies in a plane square to the camera, we solve for the ball's
// full 3D release state P0=(X0,Y0,Z0), V=(vX,vY,vZ) in a level world frame at the camera (X right,
// Y down along gravity, Z forward horizontally) such that the projected arc
//     P(τ) = P0 + V·τ + ½·(0, g, 0)·τ²,   pixel = c + f·(Xc/Zc, Yc/Zc)
// where (Xc,Yc,Zc) is P rotated into the camera, which may be tilted (pitch) and rolled.
// matches the tracked ball pixels. The throw direction comes straight out of (vX, vZ): a ball
// moving away from the camera slows down and bends in the image, which is a strong signal even
// at 30 fps. Depth is only weakly observable at normal frame rates (through gravity), so it's
// anchored by a prior: the flight line passes ~one release-radius to the side of the thrower.

import { invert } from './fit';
import { G } from './physics';

export interface Cam {
  f: number; // focal length, analysis px
  cx: number;
  cy: number;
  cos: number; // roll correction (ground line angle)
  sin: number;
  pitch?: number; // rad, + = camera tilted down (horizon above image centre)
}

export const levelPx = (c: Cam, x: number, y: number) => {
  const dx = x - c.cx, dy = y - c.cy;
  return { x: c.cx + c.cos * dx + c.sin * dy, y: c.cy - c.sin * dx + c.cos * dy };
};
export const unlevelPx = (c: Cam, x: number, y: number) => {
  const dx = x - c.cx, dy = y - c.cy;
  return { x: c.cx + c.cos * dx - c.sin * dy, y: c.cy + c.sin * dx + c.cos * dy };
};

/** Level-world point → roll-corrected ("levelled") image px, through the camera's pitch. */
export function projectLevel(c: Cam, X: number, Y: number, Z: number) {
  const p = c.pitch ?? 0;
  const cp = Math.cos(p), sp = Math.sin(p);
  const Yc = cp * Y - sp * Z;
  const Zc = Math.max(1e-3, sp * Y + cp * Z);
  return { x: c.cx + (c.f * X) / Zc, y: c.cy + (c.f * Yc) / Zc };
}

/** Level-world point → image px. */
export function project(c: Cam, X: number, Y: number, Z: number) {
  const q = projectLevel(c, X, Y, Z);
  return unlevelPx(c, q.x, q.y);
}

/** Image px → viewing ray in the level world frame (not normalised; Z component > 0 ahead). */
export function ray(c: Cam, x: number, y: number) {
  const l = levelPx(c, x, y);
  const p = c.pitch ?? 0;
  const cp = Math.cos(p), sp = Math.sin(p);
  const Xc = (l.x - c.cx) / c.f, Yc = (l.y - c.cy) / c.f;
  return { x: Xc, y: cp * Yc + sp, z: -sp * Yc + cp };
}

export interface Plan {
  x: number;
  z: number;
}

export interface Priors {
  A: Plan; // thrower axis (≈ circle centre) in plan
  ell: Plan; // unit line of sight camera → thrower
  dir: 1 | -1; // +1 if the ball moves to +x in the image
  lateral: number; // expected signed offset of the flight line from A (+ = thrower's right of throw)
  lateralSigma: number;
  psiDeg: number; // throw direction prior (0 = square to the line of sight, + = away from camera)
  psiSigmaDeg: number; // tiny → fixed (manual), large → estimated from the arc
}

export interface Obs {
  t: number;
  x: number; // image px (un-levelled)
  y: number;
}

export interface Fit3D {
  tref: number;
  p: number[]; // X0 Y0 Z0 vX vY vZ
  cov: number[][];
  sigmaPx: number; // per-point noise used (≥1.5 px)
  rmsPx: number; // actual RMS reprojection error
  n: number;
}

export const unit = (v: Plan): Plan => {
  const n = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / n, z: v.z / n };
};
/** Right-hand side of horizontal direction u, seen from above (X right, Z forward). */
export const rightOf = (u: Plan): Plan => ({ x: u.z, z: -u.x });

/** Throw direction ψ (deg) relative to square-on, + = away from the camera. */
export function psiOf(p: number[], pr: Pick<Priors, 'ell' | 'dir'>) {
  const u = unit({ x: p[3], z: p[5] });
  const side = { x: pr.dir * pr.ell.z, z: -pr.dir * pr.ell.x };
  return (Math.atan2(u.x * pr.ell.x + u.z * pr.ell.z, u.x * side.x + u.z * side.z) * 180) / Math.PI;
}

/** Signed distance of the flight line from the thrower axis (+ = right of the throw direction). */
export function lateralOf(p: number[], A: Plan) {
  const u = unit({ x: p[3], z: p[5] });
  const r = rightOf(u);
  return (p[0] - A.x) * r.x + (p[2] - A.z) * r.z;
}

export function positionAt(p: number[], tau: number) {
  return {
    X: p[0] + p[3] * tau,
    Y: p[1] + p[4] * tau + 0.5 * G * tau * tau,
    Z: p[2] + p[5] * tau,
  };
}

function residuals(p: number[], obs: Obs[], lv: { x: number; y: number }[], tref: number, c: Cam, pr: Priors, sigma: number) {
  const r: number[] = [];
  for (let i = 0; i < obs.length; i++) {
    const P = positionAt(p, obs[i].t - tref);
    const q = projectLevel(c, P.X, P.Y, Math.max(P.Z, 0.1));
    r.push((q.x - lv[i].x) / sigma, (q.y - lv[i].y) / sigma);
  }
  r.push((lateralOf(p, pr.A) - pr.lateral) / pr.lateralSigma);
  let dpsi = psiOf(p, pr) - pr.psiDeg;
  dpsi = ((dpsi + 540) % 360) - 180;
  r.push(dpsi / pr.psiSigmaDeg);
  return r;
}

function solve(A: number[][], b: number[]) {
  const inv = invert(A);
  return inv ? inv.map((row) => row.reduce((s, v, j) => s + v * b[j], 0)) : null;
}

function jacobian(f: (p: number[]) => number[], p: number[], r0: number[]) {
  const J = r0.map(() => new Array(p.length).fill(0));
  for (let j = 0; j < p.length; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(p[j]));
    const q = p.slice();
    q[j] += h;
    const r1 = f(q);
    for (let i = 0; i < r0.length; i++) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
}

export function levenberg(f: (p: number[]) => number[], p0: number[], iters = 80) {
  let p = p0.slice();
  let r = f(p);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let mu = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = jacobian(f, p, r);
    const m = p.length;
    const JtJ = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const Jtr = Array.from({ length: m }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let k = 0; k < 12; k++) {
      const Ad = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + mu * (v + 1e-9) : v)));
      const d = solve(Ad, Jtr.map((v) => -v));
      if (!d) break;
      const q = p.map((v, i) => v + d[i]);
      if (q[2] <= 0.2) { mu *= 4; continue; }
      const rq = f(q);
      const cq = rq.reduce((s, v) => s + v * v, 0);
      if (cq < cost) {
        const rel = (cost - cq) / Math.max(cost, 1e-12);
        p = q; r = rq; cost = cq; mu = Math.max(mu / 3, 1e-9);
        improved = true;
        if (rel < 1e-10) return { p, r, cost };
        break;
      }
      mu *= 4;
    }
    if (!improved) break;
  }
  return { p, r, cost };
}

/**
 * Fit the 3D release state. `tref` is the release time (P0, V are the state at release).
 * `init` is the depth guess for the release point.
 */
export function fit3D(obs: Obs[], tref: number, c: Cam, pr: Priors, init: { Z0: number; vImg: { x: number; y: number }; pImg: { x: number; y: number } }): Fit3D | null {
  if (obs.length < 3) return null;
  const lv = obs.map((o) => levelPx(c, o.x, o.y));
  // Start on the viewing ray through the first point, at the prior depth, moving square-on.
  const Z0 = init.Z0;
  const at = (x: number, y: number) => {
    const r = ray(c, x, y);
    const k = Z0 / r.z;
    return { X: r.x * k, Y: r.y * k, Z: Z0 };
  };
  const dt = 0.01;
  const a = at(init.pImg.x, init.pImg.y);
  const b = at(init.pImg.x + init.vImg.x * dt, init.pImg.y + init.vImg.y * dt);
  const p0 = [a.X, a.Y, Z0, (b.X - a.X) / dt, (b.Y - a.Y) / dt, 0];

  // Blob centroids near clutter (cage posts, net, the athlete) are realistically ~1.5 px.
  const floor = 1.5;
  let sigma = floor;
  let best = levenberg((p) => residuals(p, obs, lv, tref, c, pr, sigma), p0);
  // Re-weight once with the observed pixel noise, so priors and data are balanced honestly.
  const imgRms = (p: number[]) => {
    const r = residuals(p, obs, lv, tref, c, pr, 1).slice(0, 2 * obs.length);
    return Math.sqrt(r.reduce((s, v) => s + v * v, 0) / obs.length);
  };
  const dof = Math.max(1, 2 * obs.length - 4);
  sigma = Math.max(floor, imgRms(best.p) * Math.sqrt((2 * obs.length) / dof) / Math.SQRT2);
  best = levenberg((p) => residuals(p, obs, lv, tref, c, pr, sigma), best.p);

  const f = (p: number[]) => residuals(p, obs, lv, tref, c, pr, sigma);
  const J = jacobian(f, best.p, f(best.p));
  const m = 6;
  const JtJ = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
  const cov = invert(JtJ);
  if (!cov) return null;
  return { tref, p: best.p, cov, sigmaPx: sigma, rmsPx: imgRms(best.p), n: obs.length };
}

/** Release metrics from a 3D state. `camHeight` = camera height above the ground (m). */
export function metrics(p: number[], camHeight: number) {
  const vh = Math.hypot(p[3], p[5]);
  return {
    speed: Math.hypot(vh, p[4]),
    angle: (Math.atan2(-p[4], vh) * 180) / Math.PI,
    height: camHeight - p[1],
  };
}
