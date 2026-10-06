// Camera-motion compensation. Phones are often hand-held, and people instinctively tilt up to
// follow the hammer — even a few pixels of drift reads as fake gravity in the arc fit.
// We estimate each frame's translation against the first frame by block matching textured
// background patches (athlete excluded), and work in that fixed "reference" frame.

import type { Box } from './motion';

export interface Offset {
  x: number;
  y: number;
}

const PATCH = 12; // half-size → 25×25 patches
const STEP = 24;

/** Content shift from frame a to frame b (b ≈ a moved by (dx, dy)), robust median over patches. */
export function estimateShift(a: Uint8Array, b: Uint8Array, W: number, H: number, exclude: Box[], maxShift = 10): Offset | null {
  // Pick the most textured patches (gradient energy), away from borders and excluded boxes.
  const cands: { x: number; y: number; e: number }[] = [];
  const m = PATCH + maxShift + 1;
  for (let y = m; y < H - m; y += STEP) {
    for (let x = m; x < W - m; x += STEP) {
      if (exclude.some((bx) => x >= bx.x0 - PATCH && x <= bx.x1 + PATCH && y >= bx.y0 - PATCH && y <= bx.y1 + PATCH)) continue;
      let e = 0;
      for (let yy = y - PATCH; yy <= y + PATCH; yy += 2) {
        for (let xx = x - PATCH; xx <= x + PATCH; xx += 2) {
          const i = yy * W + xx;
          e += Math.abs(a[i + 1] - a[i - 1]) + Math.abs(a[i + W] - a[i - W]);
        }
      }
      cands.push({ x, y, e });
    }
  }
  cands.sort((p, q) => q.e - p.e);
  const use = cands.slice(0, 40).filter((c) => c.e > 0);
  if (use.length < 5) return null;

  const dxs: number[] = [], dys: number[] = [];
  for (const c of use) {
    let best = Infinity, bx = 0, by = 0;
    const sad = (dx: number, dy: number) => {
      let s = 0;
      for (let yy = -PATCH; yy <= PATCH; yy += 2) {
        const ra = (c.y + yy) * W + c.x, rb = (c.y + yy + dy) * W + c.x + dx;
        for (let xx = -PATCH; xx <= PATCH; xx += 2) s += Math.abs(a[ra + xx] - b[rb + xx]);
      }
      return s;
    };
    const grid: number[][] = [];
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      const row: number[] = [];
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        const s = sad(dx, dy);
        row.push(s);
        if (s < best) { best = s; bx = dx; by = dy; }
      }
      grid.push(row);
    }
    if (Math.abs(bx) === maxShift || Math.abs(by) === maxShift) continue; // hit the search edge
    // Sub-pixel refinement with a parabola through the neighbours.
    const g = (dx: number, dy: number) => grid[dy + maxShift][dx + maxShift];
    const sub = (l: number, c0: number, r: number) => {
      const d = l - 2 * c0 + r;
      return d > 0 ? (0.5 * (l - r)) / d : 0;
    };
    dxs.push(bx + sub(g(bx - 1, by), g(bx, by), g(bx + 1, by)));
    dys.push(by + sub(g(bx, by - 1), g(bx, by), g(bx, by + 1)));
  }
  if (dxs.length < 5) return null;
  const med = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)];
  return { x: med(dxs), y: med(dys) };
}

/** Cumulative offsets of every frame relative to frame 0 (frame-to-frame matching, chained). */
export function computeOffsets(grays: Uint8Array[], W: number, H: number, exclude: (i: number) => Box[]): Offset[] {
  const off: Offset[] = [{ x: 0, y: 0 }];
  for (let i = 1; i < grays.length; i++) {
    const s = estimateShift(grays[i - 1], grays[i], W, H, [...exclude(i - 1), ...exclude(i)]);
    const p = off[i - 1];
    off.push(s ? { x: p.x + s.x, y: p.y + s.y } : { ...p });
  }
  // Below a pixel of total drift it's just noise: treat the camera as fixed.
  const maxDrift = Math.max(...off.map((o) => Math.hypot(o.x, o.y)));
  return maxDrift < 1 ? off.map(() => ({ x: 0, y: 0 })) : off;
}

/** Shift an image by integer (dx, dy) (content moves by +dx, +dy); exposed edges copy the border. */
export function shiftImage(src: Uint8Array, W: number, H: number, dx: number, dy: number): Uint8Array {
  if (!dx && !dy) return src;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(H - 1, Math.max(0, y - dy));
    for (let x = 0; x < W; x++) out[y * W + x] = src[sy * W + Math.min(W - 1, Math.max(0, x - dx))];
  }
  return out;
}
