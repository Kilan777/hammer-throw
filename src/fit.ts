// Ballistic fit of tracked ball positions (image pixels, y down) vs time.
//   x(t) = x0 + vx·τ (+ ½·ax·τ² when freeX — perspective bends x if the throw isn't square-on)
//   y(t) = y0 + vy·τ + ½·a·τ²      τ = t − tref
// Used for tracking and outlier checks in image space; the metric answer comes from fit3d.ts.

export interface Pt {
  t: number;
  x: number;
  y: number;
}

export interface BallisticFit {
  tref: number;
  x0: number;
  vx: number;
  ax: number;
  y0: number;
  vy: number;
  a: number;
  aFixed: boolean;
  /** Covariance of [x0, vx] and of [y0, vy, (a)] */
  covX: number[][];
  covY: number[][];
  sigma: number; // RMS residual (px)
  n: number;
}

/** Solve min ||A p − b|| via normal equations. Returns params and (AᵀA)⁻¹. */
export function lstsq(A: number[][], b: number[]): { p: number[]; inv: number[][] } | null {
  const m = A[0].length;
  const ata = Array.from({ length: m }, () => new Array(m).fill(0));
  const atb = new Array(m).fill(0);
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < m; i++) {
      atb[i] += A[r][i] * b[r];
      for (let j = 0; j < m; j++) ata[i][j] += A[r][i] * A[r][j];
    }
  }
  const inv = invert(ata);
  if (!inv) return null;
  const p = inv.map((row) => row.reduce((s, v, j) => s + v * atb[j], 0));
  return { p, inv };
}

export function invert(M: number[][]): number[][] | null {
  const n = M.length;
  const a = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Fit a ballistic arc. With `fixedA` the vertical curvature is held at that value (px/s²),
 * which is far more stable when only a handful of 30 fps frames are available.
 */
export function fitBallistic(pts: Pt[], fixedA?: number, freeX = false): BallisticFit | null {
  const n = pts.length;
  const minPts = fixedA === undefined || freeX ? 3 : 2;
  if (n < minPts) return null;
  const tref = pts.reduce((s, p) => s + p.t, 0) / n;
  const tau = pts.map((p) => p.t - tref);

  const fx = lstsq(
    tau.map((t) => (freeX ? [1, t, 0.5 * t * t] : [1, t])),
    pts.map((p) => p.x),
  );
  if (!fx) return null;

  let y0: number, vy: number, a: number, invY: number[][];
  if (fixedA === undefined) {
    const fy = lstsq(
      tau.map((t) => [1, t, 0.5 * t * t]),
      pts.map((p) => p.y),
    );
    if (!fy) return null;
    [y0, vy, a] = fy.p;
    invY = fy.inv;
  } else {
    const fy = lstsq(
      tau.map((t) => [1, t]),
      pts.map((p, i) => p.y - 0.5 * fixedA * tau[i] * tau[i]),
    );
    if (!fy) return null;
    [y0, vy] = fy.p;
    a = fixedA;
    invY = fy.inv;
  }
  const [x0, vx, ax = 0] = fx.p;

  let ss = 0;
  pts.forEach((p, i) => {
    const t = tau[i];
    ss += (p.x - (x0 + vx * t + 0.5 * ax * t * t)) ** 2 + (p.y - (y0 + vy * t + 0.5 * a * t * t)) ** 2;
  });
  const dof = 2 * n - (fx.p.length + invY.length);
  // Blob centroids are realistically good to ~1 px; with few points the residual estimate is
  // meaningless, so assume ~1.5 px.
  const sigma = dof >= 2 ? Math.max(1.0, Math.sqrt(ss / dof)) : 1.5;
  const s2 = sigma * sigma;
  return {
    tref,
    x0,
    vx,
    ax,
    y0,
    vy,
    a,
    aFixed: fixedA !== undefined,
    covX: fx.inv.map((r) => r.map((v) => v * s2)),
    covY: invY.map((r) => r.map((v) => v * s2)),
    sigma: Math.sqrt(ss / n),
    n,
  };
}

export function evalFit(f: BallisticFit, t: number) {
  const tau = t - f.tref;
  return {
    x: f.x0 + f.vx * tau + 0.5 * f.ax * tau * tau,
    y: f.y0 + f.vy * tau + 0.5 * f.a * tau * tau,
    vx: f.vx + f.ax * tau,
    vy: f.vy + f.a * tau,
  };
}

/** Draw a correlated normal sample from a covariance matrix (Cholesky). */
export function sampleMvn(mean: number[], cov: number[][], rand: () => number): number[] {
  const n = mean.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = cov[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 0)) : L[j][j] > 0 ? s / L[j][j] : 0;
    }
  }
  const z = mean.map(() => gauss(rand));
  return mean.map((m, i) => m + L[i].reduce((s, l, k) => s + l * z[k], 0));
}

function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Small deterministic PRNG so uncertainty numbers don't flicker between re-renders. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
