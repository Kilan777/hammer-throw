// Finds the hammer ball's post-release flight among per-frame motion candidates.
// RANSAC over ballistic arcs: sample 3 candidates in nearby frames, fit an arc, then
// walk forwards/backwards frame by frame collecting the candidate nearest the prediction.
// The longest physically plausible arc (rising, moving away from the thrower) wins.

import type { Candidate } from './motion';
import { evalFit, fitBallistic, mulberry32, type BallisticFit } from './fit';
import { G } from './physics';

export interface FrameCands {
  frame: number;
  t: number;
  cands: Candidate[];
  body: { x: number; y: number } | null; // thrower centre (hips), analysis px
}

export interface TrackPoint {
  frame: number;
  t: number;
  x: number;
  y: number;
  manual: boolean;
}

export interface TrackOptions {
  W: number;
  H: number;
  fps: number;
  ppm: number | null; // pixels per metre if known
  iterations?: number;
  /** Override the physical plausibility limits (e.g. screening clips of unknown scale/speed). */
  override?: Partial<Bounds>;
}

export interface Bounds {
  vMin: number;
  vMax: number;
  aMin: number;
  aMax: number;
  tol: number;
  maxGap: number;
}

function bounds(o: TrackOptions): Bounds {
  return { ...baseBounds(o), ...o.override };
}

function baseBounds(o: TrackOptions): Bounds {
  const tol = Math.max(4, 0.013 * o.W);
  if (o.ppm) {
    // Image curvature isn't just gravity: a ball flying away from the camera also appears to
    // decelerate and bend (perspective), so the upper bound is generous.
    // 7 m/s ≈ a 6 m throw: low enough for youth, novice and heavy Scottish hammers.
    return { vMin: 7 * o.ppm, vMax: 45 * o.ppm, aMin: 0.2 * G * o.ppm, aMax: 7 * G * o.ppm, tol, maxGap: 2 };
  }
  return { vMin: 0.4 * o.W, vMax: 0.35 * o.W * o.fps, aMin: 1e-3, aMax: Infinity, tol, maxGap: 2 };
}

/** Gravity-like curvature is only measurable once an arc spans enough points. */
const MIN_PTS_FOR_A = 6;

function plausible(f: BallisticFit, tStart: number, b: Bounds, checkA = true): boolean {
  if (checkA && (f.a < b.aMin || f.a > b.aMax)) return false;
  // Perspective can bend x (throw angled toward/away from camera), but only so much.
  if (Math.abs(f.ax) > 2.5 * Math.abs(f.vx)) return false;
  const s = evalFit(f, tStart);
  const v = Math.hypot(s.vx, s.vy);
  if (v < b.vMin || v > b.vMax) return false;
  // Image y points down: a rising ball has vy < 0. Release angles are ~25–50°.
  const ang = (Math.atan2(-s.vy, Math.abs(s.vx)) * 180) / Math.PI;
  return ang > 5 && ang < 75;
}

/** Collect the candidate nearest to the arc in each frame, walking out from [f0, f1]. */
export function collectAlongArc(
  frames: FrameCands[],
  fit: BallisticFit,
  f0: number,
  f1: number,
  o: TrackOptions,
  b: Bounds,
  tolScale = 1,
): { pts: TrackPoint[]; resid: number } {
  const tol = b.tol * tolScale;
  const pts: TrackPoint[] = [];
  let resid = 0;
  const margin = 0.05 * o.W;
  const visit = (i: number) => {
    const fr = frames[i];
    const p = evalFit(fit, fr.t);
    if (p.x < -margin || p.x > o.W + margin || p.y < -margin || p.y > o.H + margin) return 'out';
    let best: Candidate | null = null;
    let bd = tol;
    for (const c of fr.cands) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (!best) return 'miss';
    pts.push({ frame: fr.frame, t: fr.t, x: best.x, y: best.y, manual: false });
    resid += bd;
    return 'hit';
  };
  for (const [start, step] of [[f0, -1], [f0 + 1, 1]] as const) {
    let gap = 0;
    for (let i = start; i >= 0 && i < frames.length; i += step) {
      const inCore = i >= f0 && i <= f1;
      const r = visit(i);
      if (r === 'out' && !inCore) break;
      if (r === 'hit') gap = 0;
      else if (!inCore && ++gap > b.maxGap) break;
    }
  }
  pts.sort((a, b2) => a.frame - b2.frame);
  return { pts, resid };
}

export function findTrack(frames: FrameCands[], o: TrackOptions): TrackPoint[] {
  const b = bounds(o);
  const rand = mulberry32(1234);
  const pool: { fi: number; c: Candidate }[] = [];
  frames.forEach((fr, fi) => fr.cands.forEach((c) => pool.push({ fi, c })));
  if (pool.length < 3) return [];

  const pick = (fi: number) => {
    const cs = frames[fi]?.cands;
    return cs && cs.length ? cs[Math.floor(rand() * cs.length)] : null;
  };

  // Seed samples ~33–100 ms apart in REAL time (o.fps is real frames per second, so slow-motion
  // clips space their samples further apart in frames).
  const gMin = Math.max(1, Math.round(0.033 * o.fps));
  const gMax = Math.max(gMin + 2, Math.round(0.1 * o.fps));
  let best: { pts: TrackPoint[]; score: number } | null = null;
  const iters = o.iterations ?? 6000;
  for (let it = 0; it < iters; it++) {
    const A = pool[Math.floor(rand() * pool.length)];
    const fb = A.fi + gMin + Math.floor(rand() * (gMax - gMin + 1));
    const fc = fb + gMin + Math.floor(rand() * (gMax - gMin + 1));
    const B = pick(fb);
    const C = pick(fc);
    if (!B || !C) continue;
    const sample = [
      { t: frames[A.fi].t, x: A.c.x, y: A.c.y },
      { t: frames[fb].t, x: B.x, y: B.y },
      { t: frames[fc].t, x: C.x, y: C.y },
    ];
    // Seed with straight-line x: robust over a few frames, unlike an exact 3-point curve.
    const fit = fitBallistic(sample);
    // A 3-point seed's curvature is mostly noise (especially in slow motion): judge only speed
    // and direction here; gravity is checked once the arc has grown.
    if (!fit || !plausible(fit, sample[0].t, b, false)) continue;
    const xr = sample.map((p) => Math.abs(p.x - evalFit(fit, p.t).x));
    if (Math.max(...xr) > b.tol) continue;

    let { pts, resid } = collectAlongArc(frames, fit, A.fi, fc, o, b);
    if (pts.length < 3 || !movesAway(frames, pts) || !progresses(pts, fit)) continue;
    if (pts.length >= 4) ({ pts, resid } = grow(frames, pts, resid, o, b));
    if (pts.length >= MIN_PTS_FOR_A) {
      const ff = fitBallistic(pts, undefined, pts.length >= 5);
      if (!ff || !plausible(ff, pts[0].t, b)) continue;
    }
    const score = pts.length - (0.3 * resid) / (pts.length * b.tol);
    if (!best || score > best.score) best = { pts, score };
  }
  return best ? trimStart(best.pts, b) : [];
}

/**
 * The hammer is still on its orbit just before release and orbit points can chain onto the
 * front of the flight. Fit the later "core" of the track and drop leading points that miss it.
 */
function trimStart(pts: TrackPoint[], b: Bounds): TrackPoint[] {
  if (pts.length < 6) return pts;
  const core = pts.slice(pts.length >= 8 ? 3 : 2);
  const fit = fitBallistic(core, undefined, core.length >= 5);
  if (!fit) return pts;
  // Extrapolating backwards is itself uncertain, so widen the gate by the fit's prediction error.
  const predSd = (cov: number[][], tau: number) => {
    const g = [1, tau, 0.5 * tau * tau].slice(0, cov.length);
    return Math.sqrt(Math.max(0, g.reduce((s, gi, i) => s + gi * g.reduce((t, gj, j) => t + cov[i][j] * gj, 0), 0)));
  };
  let k = 0;
  while (k < pts.length - core.length) {
    const tau = pts[k].t - fit.tref;
    const e = evalFit(fit, pts[k].t);
    const sd = Math.hypot(predSd(fit.covX, tau), predSd(fit.covY, tau), Math.max(1, fit.sigma));
    if (Math.hypot(e.x - pts[k].x, e.y - pts[k].y) <= Math.max(3, 4 * sd)) break;
    k++;
  }
  return pts.slice(k);
}

/**
 * Refit on the inliers and re-collect until the track stops growing. Once there are enough
 * points, x may curve too (perspective, when the throw isn't square to the camera).
 */
function grow(frames: FrameCands[], pts: TrackPoint[], resid: number, o: TrackOptions, b: Bounds) {
  for (let k = 0; k < 6; k++) {
    const fit = fitBallistic(pts, undefined, pts.length >= 5);
    if (!fit || !plausible(fit, pts[0].t, b, pts.length >= MIN_PTS_FOR_A)) break;
    const fi0 = frames.findIndex((f) => f.frame === pts[0].frame);
    const fi1 = frames.findIndex((f) => f.frame === pts[pts.length - 1].frame);
    const next = collectAlongArc(frames, fit, fi0, fi1, o, b, 1.25);
    if (next.pts.length <= pts.length || !progresses(next.pts, fit)) break;
    pts = next.pts;
    resid = next.resid;
  }
  return { pts, resid };
}

/**
 * A real flight covers ground every frame. Clutter near the thrower (arms, wire) can line up
 * with a slow arc while hardly moving, so require each step to make real progress along x.
 */
function progresses(pts: TrackPoint[], fit: BallisticFit): boolean {
  const sign = Math.sign(fit.vx) || 1;
  // Compare points at least ~1/30 s (real) apart, so slow-motion jitter on tiny steps doesn't count.
  for (let i = 1; i < pts.length; i++) {
    let j = i - 1;
    while (j > 0 && pts[i].t - pts[j].t < 0.9 / 30) j--;
    const dt = pts[i].t - pts[j].t;
    const expected = Math.abs(evalFit(fit, (pts[i].t + pts[j].t) / 2).vx) * dt;
    if ((pts[i].x - pts[j].x) * sign < 0.4 * expected) return false;
  }
  return true;
}

function movesAway(frames: FrameCands[], pts: TrackPoint[]): boolean {
  const bodies = frames.filter((f) => f.body).map((f) => f.body!);
  if (!bodies.length) return true;
  const bx = bodies.reduce((s, p) => s + p.x, 0) / bodies.length;
  return Math.abs(pts[pts.length - 1].x - bx) > Math.abs(pts[0].x - bx);
}
