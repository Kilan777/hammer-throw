// Turns tracked ball positions + setup into release parameters and a predicted distance,
// using a full 3D fit of the flight (see fit3d.ts) so the throw needn't be square to the camera.

import { evalFit, fitBallistic, mulberry32, sampleMvn } from './fit';
import {
  fit3D, lateralOf, levelPx, metrics, positionAt, project, psiOf, ray, unit,
  type Cam, type Fit3D, type Plan, type Priors,
} from './fit3d';
import { HAMMERS, simulate, optimalAngleVacuum, type DragParams } from './physics';
import { bodyAngles, bodyCenter, footY, type BodyAngles, type Pose } from './pose';
import type { Candidate } from './motion';
import type { TrackPoint } from './track';

export const CIRCLE_RADIUS = 1.0675; // m, inside radius of a hammer circle

export interface FrameRecord {
  frame: number;
  t: number;
  pose: Pose | null;
  cands: Candidate[];
  /** Camera offset of this frame vs the reference (first) frame, px; absent = fixed camera. */
  off?: { x: number; y: number };
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Hand = 'right' | 'left' | 'unknown';

export interface Setup {
  cameraDistance: number; // m, horizontal distance camera → thrower (circle centre)
  distanceSigma: number; // m, how well that distance is known
  hfovDeg: number; // camera horizontal field of view
  scaleMode: 'camera' | 'gravity' | 'height';
  throwerHeight: number; // m, for scaleMode 'height'
  hammerIndex: number;
  cd: number;
  rho: number;
  groundLine: Line | null; // null → auto from feet
  circleEdge: { x: number; y: number } | null; // image point on the front edge of the circle
  releaseFrame: number | null; // null → first tracked frame
  psiMode: 'auto' | 'manual'; // throw direction: estimated from the arc, or set by hand
  psiDeg: number; // manual throw direction (0 = square-on, + = away from camera)
  hand: Hand; // sets which side of the thrower the flight line passes
  releaseRadius: number; // m, horizontal distance of the ball from the thrower's axis at release
  pitchDeg: number; // camera tilt, + = looking down (from the horizon, or circle calibration)
  timeScale: number; // real seconds per second of video: 1 = real time, 0.125 = 8× slow motion
  /** From “Calibrate from circle”: camera height and circle centre (level world frame, m). */
  calib: { H: number; C: { x: number; z: number } } | null;
}

export const DEFAULT_SETUP: Setup = {
  cameraDistance: 10,
  distanceSigma: 0.3,
  hfovDeg: 65,
  scaleMode: 'camera',
  hammerIndex: 0,
  cd: 0.6,
  rho: 1.2,
  groundLine: null,
  circleEdge: null,
  releaseFrame: null,
  psiMode: 'auto',
  psiDeg: 0,
  hand: 'right',
  releaseRadius: 1.6,
  pitchDeg: 0,
  calib: null,
  timeScale: 1,
  throwerHeight: 1.8,
};

export interface Geometry {
  A: Plan; // thrower axis
  ell: Plan;
  release: Plan; // ball at release
  u: Plan; // horizontal flight direction
  landing: Plan;
  circleCentre: Plan | null;
  camHeight: number;
  dir: 1 | -1;
}

export interface Result {
  fit: Fit3D;
  geo: Geometry;
  f: number; // focal length (analysis px)
  pxPerMetreAtThrower: number;
  dir: 1 | -1;
  releaseFrame: number;
  releaseT: number; // video time
  timeScale: number;
  /** Where the fitted flight is at video time t. */
  arcImg: (t: number) => { x: number; y: number } | null;
  /** Gravity's opinion of the clip speed (as a timeScale), when the fall is well measured. */
  suggestedTimeScale: number | null;
  releaseImg: { x: number; y: number };
  groundBelowImg: { x: number; y: number };
  velImg: { x: number; y: number }; // image direction of the release velocity
  horizImg: { x: number; y: number }; // image direction of "horizontal, along the throw"
  speed: number;
  angle: number;
  height: number;
  psi: number; // throw direction, deg (+ away from camera)
  psiAuto: boolean;
  lateral: number; // flight line offset from thrower axis (m, + = thrower's right)
  depth: number; // horizontal camera → release point distance (m)
  gravityDepth: { est: number; sd: number } | null; // same, from gravity alone (no prior)
  rangeDrag: number;
  rangeVac: number;
  offset: number;
  distDrag: number;
  distVac: number;
  flightTime: number;
  apex: number;
  pathDrag: { x: number; y: number }[];
  pathVac: { x: number; y: number }[];
  optimalAngle: number;
  unc: { dist: number; speed: number; angle: number; height: number; psi: number; lateral: number };
  scaleSens: number; // distance change if camera distance is 10% off
  body: BodyAngles | null;
  bodyFrame: number | null;
  warnings: string[];
  excluded: number[];
  cameraDrift: number; // largest camera offset compensated (px), 0 for a fixed camera
}

export function focalPx(W: number, hfovDeg: number) {
  return W / 2 / Math.tan(((hfovDeg / 2) * Math.PI) / 180);
}

export function cameraPpm(W: number, s: Setup) {
  return focalPx(W, s.hfovDeg) / s.cameraDistance;
}

/** Thrower's stature in px (median over frames with a pose), from eye level → soles. */
export function statureFromPose(frames: FrameRecord[]): number | null {
  const spans = frames
    .filter((fr) => fr.pose)
    .map((fr) => {
      const p = fr.pose!;
      return Math.max(p[29].y, p[30].y, p[31].y, p[32].y, p[27].y, p[28].y) - Math.min(p[2].y, p[5].y, p[0].y);
    })
    .filter((h) => h > 20)
    .sort((a, b) => a - b);
  return spans.length ? spans[Math.floor(spans.length / 2)] / 0.936 : null;
}

export function autoGround(frames: FrameRecord[], W: number): Line | null {
  const ys = frames
    .map((f) => { const y = footY(f.pose); return y === null ? null : y - (f.off?.y ?? 0); })
    .filter((y): y is number => y !== null)
    .sort((a, b) => a - b);
  if (ys.length < 3) return null;
  // Upper-ish percentile: feet leave the ground during turns, so the lowest points are contact.
  const y = ys[Math.floor(ys.length * 0.8)];
  return { x1: 0, y1: y, x2: W, y2: y };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export function analyze(
  frames: FrameRecord[],
  track: TrackPoint[],
  s: Setup,
  W: number,
  H: number,
): Result | { error: string } {
  const warnings: string[] = [];
  // Work in real time throughout (slow-motion clips are stretched by 1/timeScale).
  const k = s.timeScale > 0 ? s.timeScale : 1;
  if (k !== 1) {
    frames = frames.map((f) => ({ ...f, t: f.t * k }));
    track = track.map((p) => ({ ...p, t: p.t * k }));
  }
  // Everything below works in the reference frame: undo each frame's camera offset.
  const offOf = new Map(frames.map((f) => [f.frame, f.off ?? { x: 0, y: 0 }]));
  track = track.map((p) => { const o = offOf.get(p.frame) ?? { x: 0, y: 0 }; return { ...p, x: p.x - o.x, y: p.y - o.y }; });
  const camMoved = frames.some((f) => f.off && Math.hypot(f.off.x, f.off.y) > 1);
  let pts = [...track].sort((a, b) => a.t - b.t);
  if (pts.length < 3)
    return { error: 'Need at least 3 ball positions after release (5+ recommended). Use “Mark ball” to click the ball in frames after release.' };

  // ---- ground line & camera ----
  const f = focalPx(W, s.hfovDeg);
  const calib = s.calib;
  let ground = s.groundLine;
  if (!ground && !calib) {
    ground = autoGround(frames, W);
    if (!ground) {
      ground = { x1: 0, y1: H * 0.95, x2: W, y2: H * 0.95 };
      warnings.push('No feet detected — ground line is a guess. Set it with “Ground line”, or use “Calibrate”.');
    }
  }
  const theta = ground ? Math.atan2(ground.y2 - ground.y1, ground.x2 - ground.x1) : 0;
  const cam: Cam = { f, cx: W / 2, cy: H / 2, cos: Math.cos(theta), sin: Math.sin(theta), pitch: (s.pitchDeg * Math.PI) / 180 };
  if (!ground && calib) {
    // Calibrated: draw the ground line through the circle centre.
    const c = project(cam, calib.C.x, calib.H, calib.C.z);
    ground = { x1: 0, y1: c.y, x2: W, y2: c.y };
  }
  const groundLine = ground!;

  const frameT = (n: number) => frames.find((fr) => fr.frame === n)?.t;
  const dtFrame = median(frames.slice(1).map((fr, i) => fr.t - frames[i].t)) || 1 / 30;

  // ---- thrower axis: hip centre around the flight start. Without pose, use where the arc was
  // at release — the ball leaves its orbit on a tangent, i.e. level with the thrower. ----
  const near = frames.filter((fr) => fr.pose && Math.abs(fr.t - pts[0].t) < 0.6);
  const hips = near
    .map((fr) => { const h = bodyCenter(fr.pose); return h && { x: h.x - (fr.off?.x ?? 0), y: h.y - (fr.off?.y ?? 0) }; })
    .filter((h): h is { x: number; y: number } => !!h);
  const arc0 = fitBallistic(pts, undefined, pts.length >= 4);
  if (!arc0) return { error: 'Could not fit a trajectory to those points.' };
  const axisPx = hips.length
    ? { x: median(hips.map((h) => h.x)), y: median(hips.map((h) => h.y)) }
    : evalFit(arc0, pts[0].t - 0.5 * dtFrame);
  // With a circle calibration the thrower's axis is the circle centre; otherwise it's `D` metres
  // along the line of sight to the hips.
  const axRay = ray(cam, axisPx.x, axisPx.y);
  const ell = calib ? unit(calib.C) : unit({ x: axRay.x, z: axRay.z });
  // Distance to the thrower: calibrated circle, the thrower's height in pixels, or as entered.
  let D = calib ? Math.hypot(calib.C.x, calib.C.z) : s.cameraDistance;
  if (!calib && s.scaleMode === 'height') {
    // Eye level is ~93.6% of stature; measure eyes→soles on frames around the flight.
    const spans = near
      .map((fr) => {
        const p = fr.pose!;
        const top = Math.min(p[2].y, p[5].y, p[0].y);
        const bot = Math.max(p[29].y, p[30].y, p[31].y, p[32].y, p[27].y, p[28].y);
        return bot - top;
      })
      .filter((h) => h > 20)
      .sort((a, b) => a - b);
    if (spans.length) {
      const statPx = spans[Math.floor(spans.length / 2)] / 0.936;
      D = (f * s.throwerHeight) / statPx; // depth ≈ horizontal distance for a near-level camera
    } else warnings.push('No thrower detected to measure — falling back to the camera distance you entered.');
  }
  const A = calib ? calib.C : { x: D * ell.x, z: D * ell.z };

  // Camera height: calibrated, or from where the ground line sits below the thrower.
  let camHeight: number;
  if (calib) camHeight = calib.H;
  else {
    const gx = axisPx.x;
    const gy = groundLine.y1 + (gx - groundLine.x1) * Math.tan(theta);
    const gr = ray(cam, gx, gy);
    camHeight = (D / Math.hypot(gr.x, gr.z)) * gr.y;
  }
  if (camHeight < 0.2)
    warnings.push('The ground line comes out at or above camera height — the camera is probably tilted down. Use “Calibrate” (circle + horizon) or set the horizon so the tilt is known.');

  const first = levelPx(cam, pts[0].x, pts[0].y);
  const last = levelPx(cam, pts[pts.length - 1].x, pts[pts.length - 1].y);
  const dir: 1 | -1 = last.x >= first.x ? 1 : -1;

  // ---- priors ----
  const handSign = s.hand === 'right' ? 1 : s.hand === 'left' ? -1 : 0;
  const lateralPrior = handSign * s.releaseRadius;
  const lateralSigmaHand = s.hand === 'unknown' ? Math.max(0.5, s.releaseRadius) : 0.5;
  const auto = s.psiMode === 'auto';
  const gravityMode = s.scaleMode === 'gravity';
  const makePriors = (dist: number, gravityOnly: boolean, n: number): Priors => ({
    A: { x: dist * ell.x, z: dist * ell.z },
    ell,
    dir,
    lateral: lateralPrior,
    lateralSigma: gravityOnly ? 25 : Math.hypot(lateralSigmaHand, s.distanceSigma),
    psiDeg: auto ? 0 : s.psiDeg,
    // Auto: the camera was set up roughly side-on, so a soft 0 ± 20° prior; the arc pulls it
    // away from that only as far as the data really supports.
    psiSigmaDeg: auto ? (n < 5 ? 8 : 20) : 0.05,
  });
  const fitWith = (P: TrackPoint[], tRel: number, dist: number, gravityOnly: boolean) => {
    const img = fitBallistic(P, undefined, P.length >= 4);
    if (!img) return null;
    const e = evalFit(img, tRel);
    // Initial depth: for a square-on throw the flight line sits `lateral` toward/away from the camera.
    const init = { Z0: Math.max(1, (dist - dir * lateralPrior) * ell.z), vImg: { x: e.vx, y: e.vy }, pImg: { x: e.x, y: e.y } };
    return fit3D(P.map((p) => ({ t: p.t, x: p.x, y: p.y })), tRel, cam, makePriors(dist, gravityOnly, P.length), init);
  };
  // Auto release time: let go between the last attached frame and the first free one → midpoint.
  const autoRelT = (P: TrackPoint[]) => P[0].t - 0.5 * dtFrame;

  // ---- outlier rejection against the physical 3D arc ----
  // Gravity is fixed, so (unlike a free 2D curve) the arc can't bend to swallow bad points:
  // a blurry first frame, or orbit points from just before release chained onto the front.
  // Never drop below 6 points — the throw angle needs a long baseline more than purity.
  const excluded: number[] = [];
  let releaseT = s.releaseFrame !== null ? frameT(s.releaseFrame) ?? autoRelT(pts) : autoRelT(pts);
  let fit = fitWith(pts, releaseT, D, gravityMode);
  while (fit && pts.length >= 7) {
    const f0 = fit;
    let worst = -1, wd = 0;
    pts.forEach((p, i) => {
      if (p.manual) return;
      const P = positionAt(f0.p, p.t - f0.tref);
      const q = project(cam, P.X, P.Y, P.Z);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d > wd) { wd = d; worst = i; }
    });
    // Fixed gate (≈4.5 px at 640 wide): the fitted noise level is inflated by the very outliers
    // we're looking for, so it can't set the threshold.
    if (worst < 0 || wd <= 4.5 * (W / 640)) break;
    excluded.push(pts[worst].frame);
    pts = pts.filter((_, j) => j !== worst);
    if (s.releaseFrame === null) releaseT = autoRelT(pts);
    fit = fitWith(pts, releaseT, D, gravityMode);
  }
  if (!fit) return { error: 'Could not fit a 3D trajectory to those points.' };

  // With the thrower visible, the release is where the flight line passes closest to their axis
  // (the ball leaves its orbit on a tangent). Points before that are still on the orbit — they sit
  // within a few px of the arc but skew the throw angle badly — so drop them, then refit.
  if (s.releaseFrame === null && hips.length) {
    for (let k = 0; k < 3 && fit; k++) {
      // Judge from the later "core" points, which are surely post-release: an orbit point at the
      // front skews the full fit's direction, and with it this very estimate.
      const core = pts.length >= 8 ? pts.slice(2) : pts.length >= 6 ? pts.slice(1) : pts;
      const cf = (core === pts ? fit : fitWith(core, releaseT, D, gravityMode)) ?? fit;
      const u0 = unit({ x: cf.p[3], z: cf.p[5] });
      const vh = Math.hypot(cf.p[3], cf.p[5]);
      const along = (cf.p[0] - A.x) * u0.x + (cf.p[2] - A.z) * u0.z;
      const tTangent = cf.tref - along / vh;
      const early = pts.filter((p) => !p.manual && p.t < tTangent - 0.3 * dtFrame);
      if (early.length && pts.length - early.length >= 4) {
        excluded.push(...early.map((p) => p.frame));
        pts = pts.filter((p) => !early.includes(p));
      }
      const tGeo = Math.min(pts[0].t, Math.max(pts[0].t - 2 * dtFrame, tTangent));
      if (!early.length && Math.abs(tGeo - releaseT) < 1e-4) break;
      releaseT = tGeo;
      fit = fitWith(pts, releaseT, D, gravityMode) ?? fit;
    }
  } else if (s.releaseFrame === null && !hips.length) {
    warnings.push('Thrower not detected, so the exact release moment is less certain — check the first ball point is after release.');
  }
  const relFrame = s.releaseFrame ?? pts[0].frame;
  const obs = pts.map((p) => ({ t: p.t, x: p.x, y: p.y }));
  if (auto && pts.length < 5) warnings.push('Few points, so the throw angle is mostly assumed square-on. Add points or set the angle by hand.');

  const hammer = HAMMERS[s.hammerIndex] ?? HAMMERS[0];
  const drag: DragParams = { mass: hammer.mass, diameter: hammer.diameter, cd: s.cd, rho: s.rho };

  const m = metrics(fit.p, camHeight);
  const psi = psiOf(fit.p, { ell, dir });
  const lateral = lateralOf(fit.p, A);
  const u = unit({ x: fit.p[3], z: fit.p[5] });
  const release = { x: fit.p[0], z: fit.p[2] };
  const depth = Math.hypot(release.x, release.z);
  if (m.height < 0 || m.height > 4) warnings.push(`Release height ${m.height.toFixed(2)} m looks wrong — check the ground line and camera distance.`);
  if (auto && Math.abs(psi) > 45) warnings.push(`Estimated throw direction is ${psi.toFixed(0)}° off square — film more side-on, or check for bad points.`);
  if (fit.rmsPx > 3) warnings.push(`Ball points don't sit on one clean arc (${fit.rmsPx.toFixed(1)} px off on average) — check for wrong points.`);
  if (pts.length < 4) warnings.push(`Only ${pts.length} ball positions — numbers are rough. Add more by clicking the ball in later frames.`);
  else if (pts[pts.length - 1].t - pts[0].t < 0.15)
    warnings.push(`Ball positions only span ${Math.round((pts[pts.length - 1].t - pts[0].t) * 1000)} ms — speed is sensitive to small click errors. Mark the ball over a longer stretch of flight.`);
  if (excluded.length) warnings.push(`Ignored ${excluded.length} auto-detected point${excluded.length > 1 ? 's' : ''} that didn't fit the arc (frame ${excluded.join(', ')}).`);

  // ---- gravity-only depth check (no prior on where the flight line is) ----
  let gravityDepth: Result['gravityDepth'] = null;
  if (pts.length >= 5) {
    const g = gravityMode ? fit : fitWith(pts, releaseT, D, true);
    if (g) {
      const est = Math.hypot(g.p[0], g.p[2]);
      const sdz = Math.sqrt(Math.max(0, g.cov[2][2]));
      gravityDepth = { est, sd: sdz };
      if (!gravityMode && sdz < 0.3 * est && Math.abs(est - depth) > Math.max(2.5 * sdz, 0.15 * depth))
        warnings.push(`Gravity says the ball flew ${est.toFixed(1)} ± ${sdz.toFixed(1)} m from the camera, but the setup implies ${depth.toFixed(1)} m — check camera distance, FOV and thrower hand.`);
    }
  }
  if (gravityMode && Math.sqrt(fit.cov[2][2]) > 0.1 * depth)
    warnings.push(`Gravity-only depth is uncertain (±${Math.sqrt(fit.cov[2][2]).toFixed(1)} m) — at normal frame rates the camera-distance setup is usually more accurate.`);

  // ---- flight ----
  const dragFlight = simulate(m.speed, m.angle, Math.max(0, m.height), drag);
  const vacFlight = simulate(m.speed, m.angle, Math.max(0, m.height), null);
  const landing = { x: release.x + u.x * dragFlight.range, z: release.z + u.z * dragFlight.range };

  // Official-style distance: from the circle's inner edge, along the line to its centre.
  let offset = 0;
  let circleCentre: Plan | null = null;
  if (calib) {
    circleCentre = calib.C;
  } else if (s.circleEdge) {
    const e = ray(cam, s.circleEdge.x, s.circleEdge.y);
    if (e.y > 1e-3) {
      const lam = camHeight / e.y;
      const E = { x: lam * e.x, z: lam * e.z };
      circleCentre = { x: E.x - CIRCLE_RADIUS * u.x, z: E.z - CIRCLE_RADIUS * u.z };
    } else warnings.push('Circle edge click is above the horizon — click where the circle meets the ground.');
  }
  if (circleCentre) offset = Math.hypot(landing.x - circleCentre.x, landing.z - circleCentre.z) - CIRCLE_RADIUS - dragFlight.range;

  // ---- uncertainty (Monte-Carlo over the fit covariance) ----
  const rand = mulberry32(42);
  const ds: number[] = [], ss: number[] = [], as: number[] = [], hs: number[] = [], ps: number[] = [], ls: number[] = [];
  for (let i = 0; i < 200; i++) {
    const p = sampleMvn(fit.p, fit.cov, rand);
    if (p[2] <= 0.5) continue;
    const r = metrics(p, camHeight);
    ds.push(simulate(r.speed, r.angle, Math.max(0, r.height), drag).range);
    ss.push(r.speed);
    as.push(r.angle);
    hs.push(r.height);
    ps.push(psiOf(p, { ell, dir }));
    ls.push(lateralOf(p, A));
  }
  const sd = (a: number[]) => {
    if (a.length < 2) return 0;
    const mu = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1));
  };

  // Sensitivity: camera distance 10% further (camera height scales with it too).
  let scaleSens = 0;
  if (!gravityMode) {
    const f10 = fitWith(pts, releaseT, D * 1.1, false);
    if (f10) {
      const m10 = metrics(f10.p, camHeight * 1.1);
      scaleSens = Math.abs(simulate(m10.speed, m10.angle, Math.max(0, m10.height), drag).range - dragFlight.range);
    }
  }

  // ---- body angles at (or nearest to) release ----
  let bodyFrame: number | null = null;
  let body: BodyAngles | null = null;
  const withPose = frames.filter((fr) => fr.pose);
  if (withPose.length) {
    const nb = withPose.reduce((a, b) => (Math.abs(b.t - releaseT) < Math.abs(a.t - releaseT) ? b : a));
    if (Math.abs(nb.t - releaseT) < 0.15) {
      bodyFrame = nb.frame;
      body = bodyAngles(nb.pose!, dir);
    }
  }

  // ---- image-space annotations ----
  const P0 = positionAt(fit.p, 0);
  const releaseImg = project(cam, P0.X, P0.Y, P0.Z);
  const vImg = project(cam, P0.X + fit.p[3] * 0.02, P0.Y + fit.p[4] * 0.02, P0.Z + fit.p[5] * 0.02);
  const hImg = project(cam, P0.X + u.x * 0.5, P0.Y, P0.Z + u.z * 0.5);
  const arcImg = (tVideo: number) => {
    const P = positionAt(fit.p, tVideo * k - releaseT);
    return P.Z > 0.3 ? project(cam, P.X, P.Y, P.Z) : null;
  };

  return {
    fit,
    geo: { A, ell, release, u, landing, circleCentre, camHeight, dir },
    f,
    pxPerMetreAtThrower: f / D,
    dir,
    releaseFrame: relFrame,
    releaseT: releaseT / k,
    timeScale: k,
    arcImg,
    // Gravity-only depth scales as (assumed/true time scale)²: invert that for a suggestion.
    suggestedTimeScale:
      gravityDepth && gravityDepth.sd < 0.12 * gravityDepth.est && !gravityMode ? k * Math.sqrt(depth / gravityDepth.est) : null,
    releaseImg,
    groundBelowImg: project(cam, P0.X, camHeight, P0.Z),
    velImg: { x: vImg.x - releaseImg.x, y: vImg.y - releaseImg.y },
    horizImg: { x: hImg.x - releaseImg.x, y: hImg.y - releaseImg.y },
    speed: m.speed,
    angle: m.angle,
    height: m.height,
    psi,
    psiAuto: auto,
    lateral,
    depth,
    gravityDepth,
    rangeDrag: dragFlight.range,
    rangeVac: vacFlight.range,
    offset,
    distDrag: dragFlight.range + offset,
    distVac: vacFlight.range + offset,
    flightTime: dragFlight.flightTime,
    apex: dragFlight.apex,
    pathDrag: dragFlight.points,
    pathVac: vacFlight.points,
    optimalAngle: optimalAngleVacuum(m.speed, Math.max(0, m.height)),
    unc: { dist: sd(ds), speed: sd(ss), angle: sd(as), height: sd(hs), psi: sd(ps), lateral: sd(ls) },
    scaleSens,
    body,
    bodyFrame,
    warnings,
    excluded,
    cameraDrift: camMoved ? Math.max(...frames.map((f) => Math.hypot(f.off?.x ?? 0, f.off?.y ?? 0))) : 0,
  };
}
