// Draws annotations over a video frame. All inputs are in analysis pixels; `k` scales to canvas.

import type { Line, Result } from './analyze';
import { LM, SKELETON, bodyAngles, mid, visible, type Pose } from './pose';
import type { Candidate } from './motion';
import type { TrackPoint } from './track';

export const COLORS = {
  ball: '#ff4d6d',
  ballManual: '#ffb020',
  arc: '#ff4d6d',
  vel: '#ffd23f',
  ground: '#3ddc97',
  edge: '#4cc9f0',
  skeleton: 'rgba(120, 200, 255, 0.95)',
  joint: '#ffffff',
  angle: '#c8f',
  cand: 'rgba(255,255,255,0.55)',
};

export interface OverlayState {
  frameIndex: number;
  frameT: number;
  pose: Pose | null;
  cands: Candidate[];
  track: TrackPoint[];
  result: Result | null;
  ground: Line | null;
  circleEdge: { x: number; y: number } | null;
  showSkeleton: boolean;
  showCands: boolean;
  showArc: boolean;
  pendingGround: { x: number; y: number } | null;
  /** Calibration check: projected circle + horizon line, and clicks so far while calibrating. */
  calibOutline?: { x: number; y: number }[] | null;
  horizon?: { x1: number; y1: number; x2: number; y2: number } | null;
  calibClicks?: { x: number; y: number }[];
  /** Camera-motion compensation: this frame's offset, and any frame's (for drawing other frames' points). */
  off?: { x: number; y: number };
  offOf?: (frame: number) => { x: number; y: number };
}

export function drawOverlay(ctx: CanvasRenderingContext2D, k: number, s: OverlayState) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const fs = Math.max(11, Math.round(13 * Math.min(1.6, k * 1.3)));
  ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const r = s.result;
  // Model things (ground, calibration, fitted arc, release) live in the reference frame; shift them
  // by this frame's camera offset. Detections (pose, blobs) are already in this frame's pixels.
  const ox = s.off?.x ?? 0, oy = s.off?.y ?? 0;
  const P = (x: number, y: number) => [(x + ox) * k, (y + oy) * k] as const;

  // Ground line
  const g = s.ground;
  if (g) {
    const W = ctx.canvas.width / k;
    const slope = (g.y2 - g.y1) / (g.x2 - g.x1 || 1);
    ctx.strokeStyle = COLORS.ground;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(...P(0, g.y1 - slope * g.x1));
    ctx.lineTo(...P(W, g.y1 + slope * (W - g.x1)));
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, 'ground', ...P(8, g.y1 - slope * g.x1 + 8 - 4), COLORS.ground, 'left', 'bottom');
  }
  if (s.pendingGround) dot(ctx, ...P(s.pendingGround.x, s.pendingGround.y), 5, COLORS.ground);

  if (s.horizon) {
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    ctx.moveTo(...P(s.horizon.x1, s.horizon.y1));
    ctx.lineTo(...P(s.horizon.x2, s.horizon.y2));
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, 'horizon', ...P(s.horizon.x2 - 6, s.horizon.y2 - 4), COLORS.edge, 'right', 'bottom');
  }
  if (s.calibOutline?.length) {
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.calibOutline.forEach((q, i) => (i ? ctx.lineTo(...P(q.x, q.y)) : ctx.moveTo(...P(q.x, q.y))));
    ctx.stroke();
  }
  s.calibClicks?.forEach((q, i) => {
    dot(ctx, ...P(q.x, q.y), 5, COLORS.edge);
    label(ctx, String(i + 1), ...P(q.x + 7, q.y - 7), '#000', 'left', 'bottom', COLORS.edge);
  });

  if (s.circleEdge) {
    const { x, y } = s.circleEdge;
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(...P(x, y - 30));
    ctx.lineTo(...P(x, y + 6));
    ctx.stroke();
    dot(ctx, ...P(x, y), 3.5, COLORS.edge);
    label(ctx, 'circle edge', ...P(x, y - 32), COLORS.edge, 'center', 'bottom');
  }

  // Motion candidates (debug)
  if (s.showCands) {
    ctx.strokeStyle = COLORS.cand;
    ctx.lineWidth = 1;
    for (const c of s.cands) {
      ctx.beginPath();
      ctx.arc(c.x * k, c.y * k, Math.max(4, Math.sqrt(c.area) * k * 0.7), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Skeleton + joint angles
  if (s.showSkeleton && s.pose) drawSkeleton(ctx, k, s.pose, s.result?.dir ?? 1);

  // Fitted arc, extrapolated a bit before/after the tracked points.
  if (r && s.showArc && s.track.length) {
    const t0 = Math.min(r.releaseT, s.track[0].t) - 0.05 / r.timeScale;
    const t1 = s.track[s.track.length - 1].t + 0.6 / r.timeScale;
    ctx.strokeStyle = COLORS.arc;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 80; i++) {
      const p = r.arcImg(t0 + ((t1 - t0) * i) / 80);
      if (!p) continue;
      if (!started) ctx.moveTo(...P(p.x, p.y));
      else ctx.lineTo(...P(p.x, p.y));
      started = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Tracked ball positions (hollow = rejected as an outlier)
  const excluded = new Set(r?.excluded ?? []);
  for (const p0 of s.track) {
    const po = s.offOf?.(p0.frame) ?? { x: 0, y: 0 };
    const p = { ...p0, x: p0.x - po.x + ox, y: p0.y - po.y + oy };
    const cur = p.frame === s.frameIndex;
    const col = p.manual ? COLORS.ballManual : COLORS.ball;
    if (excluded.has(p.frame)) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x * k, p.y * k, cur ? 6 : 4, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    if (cur) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x * k, p.y * k, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    dot(ctx, p.x * k, p.y * k, cur ? 4.5 : 3.5, col);
  }

  // Release annotations: velocity, angle, height
  if (r) {
    const onRelease = s.frameIndex === r.releaseFrame;
    const [rx, ry] = P(r.releaseImg.x, r.releaseImg.y);
    const vlen = Math.hypot(r.velImg.x, r.velImg.y);
    const L = 110 * Math.min(1.5, Math.max(0.7, k));
    const ux = r.velImg.x / vlen, uy = r.velImg.y / vlen;
    ctx.globalAlpha = onRelease ? 1 : 0.55;

    // Height line down to the ground directly below the ball (at the ball's depth)
    const [gx, gy] = P(r.groundBelowImg.x, r.groundBelowImg.y);
    ctx.strokeStyle = COLORS.ground;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(gx, gy);
    ctx.stroke();
    tick(ctx, rx, ry, COLORS.ground);
    tick(ctx, gx, gy, COLORS.ground);
    label(ctx, `${r.height.toFixed(2)} m`, (rx + gx) / 2 - 8 * r.dir, (ry + gy) / 2, COLORS.ground, r.dir > 0 ? 'right' : 'left', 'middle');

    // Horizontal reference along the throw direction (as the camera sees it)
    const hn = Math.hypot(r.horizImg.x, r.horizImg.y) || 1;
    const hx = r.horizImg.x / hn, hy = r.horizImg.y / hn;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + hx * L, ry + hy * L);
    ctx.stroke();
    ctx.setLineDash([]);

    // Angle arc
    const a0 = Math.atan2(hy, hx);
    let da = Math.atan2(uy, ux) - a0;
    da = Math.atan2(Math.sin(da), Math.cos(da)); // shortest way round
    ctx.strokeStyle = COLORS.vel;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rx, ry, L * 0.55, a0, a0 + da, da < 0);
    ctx.stroke();
    const am = a0 + da / 2;
    label(ctx, `${r.angle.toFixed(1)}°`, rx + Math.cos(am) * L * 0.62, ry + Math.sin(am) * L * 0.62, COLORS.vel, r.dir > 0 ? 'left' : 'right', 'middle');

    // Velocity arrow
    arrow(ctx, rx, ry, rx + ux * L, ry + uy * L, COLORS.vel);
    label(ctx, `${r.speed.toFixed(1)} m/s`, rx + ux * (L + 8), ry + uy * (L + 8), COLORS.vel, r.dir > 0 ? 'left' : 'right', 'bottom');
    dot(ctx, rx, ry, 5, COLORS.vel);
    if (onRelease) label(ctx, 'RELEASE', rx, ry - 14, '#fff', 'center', 'bottom', COLORS.ball);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawSkeleton(ctx: CanvasRenderingContext2D, k: number, p: Pose, dir: number) {
  ctx.strokeStyle = COLORS.skeleton;
  ctx.lineWidth = 3;
  for (const [a, b] of SKELETON) {
    if (!visible(p[a], 0.4) || !visible(p[b], 0.4)) continue;
    ctx.beginPath();
    ctx.moveTo(p[a].x * k, p[a].y * k);
    ctx.lineTo(p[b].x * k, p[b].y * k);
    ctx.stroke();
  }
  for (let i = 11; i < p.length; i++) if (visible(p[i], 0.4)) dot(ctx, p[i].x * k, p[i].y * k, 3, COLORS.joint);

  const ang = bodyAngles(p, dir);
  const at = (i: number, v: number | undefined) => {
    if (v === undefined || !visible(p[i])) return;
    label(ctx, `${v.toFixed(0)}°`, p[i].x * k + 8, p[i].y * k, COLORS.angle, 'left', 'middle');
  };
  at(LM.lKnee, ang.lKnee);
  at(LM.rKnee, ang.rKnee);
  at(LM.lElbow, ang.lElbow);
  at(LM.rElbow, ang.rElbow);
  if (ang.trunkLean !== undefined) {
    const s = mid(p[LM.lShoulder], p[LM.rShoulder]);
    const h = mid(p[LM.lHip], p[LM.rHip]);
    ctx.strokeStyle = COLORS.angle;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(h.x * k, h.y * k);
    ctx.lineTo(h.x * k, (h.y - Math.hypot(s.x - h.x, s.y - h.y)) * k);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `trunk ${ang.trunkLean.toFixed(0)}°`, s.x * k + 10, s.y * k - 10, COLORS.angle, 'left', 'bottom');
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function tick(ctx: CanvasRenderingContext2D, x: number, y: number, c: string) {
  ctx.strokeStyle = c;
  ctx.beginPath();
  ctx.moveTo(x - 6, y);
  ctx.lineTo(x + 6, y);
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: string) {
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 12 * Math.cos(a - 0.4), y1 - 12 * Math.sin(a - 0.4));
  ctx.lineTo(x1 - 12 * Math.cos(a + 0.4), y1 - 12 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign,
  base: CanvasTextBaseline,
  bg = 'rgba(0,0,0,0.6)',
) {
  ctx.textAlign = align;
  ctx.textBaseline = base;
  const m = ctx.measureText(text);
  const h = parseInt(ctx.font.match(/(\d+)px/)?.[1] ?? '13', 10);
  const w = m.width;
  const bx = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  const by = base === 'top' ? y : base === 'bottom' ? y - h : y - h / 2;
  ctx.fillStyle = bg;
  roundRect(ctx, bx - 4, by - 2, w + 8, h + 4, 4);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}
