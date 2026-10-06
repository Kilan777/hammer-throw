// Finds small moving blobs in a frame (ball candidates) by three-frame differencing:
// a pixel is "moving" only if it differs from BOTH the previous and the next frame,
// which isolates where a fast object is *now* rather than where it was.

export interface Candidate {
  x: number;
  y: number;
  area: number;
  strength: number;
  w: number;
  h: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MotionOptions {
  minThreshold: number; // grey levels
  minArea: number; // px (analysis resolution)
  maxAreaFrac: number; // fraction of frame
  maxCandidates: number;
  ballRadius: number; // px at analysis resolution, for locating the ball within a blob
}

export const DEFAULT_MOTION: MotionOptions = {
  minThreshold: 12,
  minArea: 3,
  maxAreaFrac: 0.012,
  maxCandidates: 15,
  ballRadius: 3,
};

export function motionImage(prev: Uint8Array, cur: Uint8Array, next: Uint8Array): Uint8Array {
  const n = cur.length;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cur[i];
    const d1 = c > prev[i] ? c - prev[i] : prev[i] - c;
    const d2 = c > next[i] ? c - next[i] : next[i] - c;
    m[i] = d1 < d2 ? d1 : d2;
  }
  return m;
}

export function motionThreshold(m: Uint8Array, minThreshold: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < m.length; i += 3) hist[m[i]]++;
  const total = Math.ceil(m.length / 3);
  let acc = 0;
  let p90 = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.9) {
      p90 = v;
      break;
    }
  }
  return Math.max(minThreshold, 3 * p90 + 4);
}

export function detectCandidates(
  prev: Uint8Array,
  cur: Uint8Array,
  next: Uint8Array,
  W: number,
  H: number,
  exclude: Box[],
  opts: MotionOptions = DEFAULT_MOTION,
): Candidate[] {
  const m = motionImage(prev, cur, next);
  const T = motionThreshold(m, opts.minThreshold);

  // Binary mask, dilated 3×3 so fragments of a blurred streak join up.
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) raw[i] = m[i] >= T ? 1 : 0;
  const mask = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (
        raw[i] | raw[i - 1] | raw[i + 1] | raw[i - W] | raw[i + W] |
        raw[i - W - 1] | raw[i - W + 1] | raw[i + W - 1] | raw[i + W + 1]
      )
        mask[i] = 1;
    }
  }

  // Integral image of motion strength (above threshold), for ball-sized box sums.
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      row += raw[i] ? m[i] : 0;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const box = (x: number, y: number, r: number) => {
    const xa = Math.max(0, x - r), ya = Math.max(0, y - r), xb = Math.min(W, x + r + 1), yb = Math.min(H, y + r + 1);
    return S[yb * (W + 1) + xb] - S[ya * (W + 1) + xb] - S[yb * (W + 1) + xa] + S[ya * (W + 1) + xa];
  };
  const R = opts.ballRadius;

  const maxArea = W * H * opts.maxAreaFrac;
  const labels = new Int32Array(W * H);
  const stack: number[] = [];
  const members: number[] = [];
  const out: Candidate[] = [];
  let label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    labels[start] = label;
    stack.push(start);
    members.length = 0;
    let sw = 0;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (raw[i]) sw += m[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack.push(i + 1); }
      if (y > 0 && mask[i - W] && !labels[i - W]) { labels[i - W] = label; stack.push(i - W); }
      if (y < H - 1 && mask[i + W] && !labels[i + W]) { labels[i + W] = label; stack.push(i + W); }
    }
    const area = members.length;
    if (area < opts.minArea || area > maxArea || sw === 0) continue;
    // Blobs cut off by the frame edge have a biased centre — skip them.
    if (x0 <= 1 || y0 <= 1 || x1 >= W - 2 || y1 >= H - 2) continue;
    // Locate the ball, not the blob: the densest ball-sized spot. A whole-blob centroid gets
    // dragged toward the trailing wire and handle, by an amount that varies with background.
    let peak = members[0], pv = -1;
    for (const i of members) {
      const v = box(i % W, (i / W) | 0, R);
      if (v > pv) { pv = v; peak = i; }
    }
    const px = peak % W, py = (peak / W) | 0;
    let lw = 0, lx = 0, ly = 0;
    for (let y = Math.max(0, py - R - 1); y <= Math.min(H - 1, py + R + 1); y++) {
      for (let x = Math.max(0, px - R - 1); x <= Math.min(W - 1, px + R + 1); x++) {
        const i = y * W + x;
        if (labels[i] !== label || !raw[i]) continue;
        lw += m[i]; lx += m[i] * x; ly += m[i] * y;
      }
    }
    const cx = lw ? lx / lw : px;
    const cy = lw ? ly / lw : py;
    if (exclude.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1)) continue;
    out.push({ x: cx, y: cy, area, strength: sw, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, opts.maxCandidates);
}
