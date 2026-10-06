// MediaPipe pose landmarker wrapper + joint-angle helpers.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export interface Landmark {
  x: number; // analysis px
  y: number;
  v: number; // visibility 0..1
}

export type Pose = Landmark[];

// MediaPipe BlazePose indices
export const LM = {
  nose: 0,
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30,
  lFoot: 31, rFoot: 32,
} as const;

export const SKELETON: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

const LOCAL_WASM = new URL('mediapipe/wasm', document.baseURI).href.replace(/\/$/, '');
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const LOCAL_MODEL = new URL('models/pose_landmarker_full.task', document.baseURI).href;
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

async function exists(url: string) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

export async function createPoseDetector(): Promise<PoseLandmarker> {
  const wasm = (await exists(`${LOCAL_WASM}/vision_wasm_internal.wasm`)) ? LOCAL_WASM : CDN_WASM;
  const model = (await exists(LOCAL_MODEL)) ? LOCAL_MODEL : CDN_MODEL;
  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  try {
    return await make('GPU');
  } catch {
    return await make('CPU');
  }
}

/**
 * Runs pose on a square canvas (the frame is letterboxed into its top-left corner).
 * MediaPipe's landmark projection is only exact for square inputs, so we never give it a
 * non-square frame. `scale` maps square-canvas px → analysis px.
 */
export function detectPose(
  det: PoseLandmarker,
  square: HTMLCanvasElement,
  timestampMs: number,
  scale: number,
): Pose | null {
  const res = det.detectForVideo(square, timestampMs);
  const lms = res.landmarks?.[0];
  if (!lms) return null;
  const S = square.width;
  return lms.map((l) => ({ x: l.x * S * scale, y: l.y * S * scale, v: l.visibility ?? 1 }));
}

export const visible = (p: Landmark | undefined, min = 0.5): p is Landmark => !!p && p.v >= min;

/** Interior angle at b (degrees) for the chain a-b-c. */
export function jointAngle(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = [a.x - b.x, a.y - b.y];
  const v2 = [c.x - b.x, c.y - b.y];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  if (d === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / d))) * 180) / Math.PI;
}

export const mid = (a: Landmark, b: Landmark): Landmark => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });

export interface BodyAngles {
  lKnee?: number;
  rKnee?: number;
  lElbow?: number;
  rElbow?: number;
  trunkLean?: number; // degrees from vertical, + = leaning back away from throw direction
}

/** `dir` is +1 if the throw goes toward +x in the image, −1 otherwise. */
export function bodyAngles(p: Pose, dir: number): BodyAngles {
  const out: BodyAngles = {};
  const tri = (a: number, b: number, c: number) =>
    visible(p[a]) && visible(p[b]) && visible(p[c]) ? jointAngle(p[a], p[b], p[c]) : undefined;
  out.lKnee = tri(LM.lHip, LM.lKnee, LM.lAnkle);
  out.rKnee = tri(LM.rHip, LM.rKnee, LM.rAnkle);
  out.lElbow = tri(LM.lShoulder, LM.lElbow, LM.lWrist);
  out.rElbow = tri(LM.rShoulder, LM.rElbow, LM.rWrist);
  if ([LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].every((i) => visible(p[i]))) {
    const s = mid(p[LM.lShoulder], p[LM.rShoulder]);
    const h = mid(p[LM.lHip], p[LM.rHip]);
    // Positive when shoulders are behind the hips relative to the throw direction.
    out.trunkLean = (Math.atan2(-(s.x - h.x) * dir, h.y - s.y) * 180) / Math.PI;
  }
  return out;
}

/**
 * Rejects detections that aren't an upright human (false positives on cage posts, a crude
 * figure, etc.): shoulders above hips above feet, legs at least ~as long as the torso.
 */
export function plausiblePose(p: Pose | null): Pose | null {
  if (!p) return null;
  const need = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip];
  if (!need.every((i) => visible(p[i], 0.4))) return null;
  const ankles = [LM.lAnkle, LM.rAnkle].filter((i) => visible(p[i], 0.3)).map((i) => p[i]);
  if (!ankles.length) return null;
  const sh = mid(p[LM.lShoulder], p[LM.rShoulder]);
  const hip = mid(p[LM.lHip], p[LM.rHip]);
  const ankleY = Math.max(...ankles.map((a) => a.y));
  const torso = hip.y - sh.y;
  const legs = ankleY - hip.y;
  return torso > 0 && legs > 0.8 * torso && legs < 3 * torso ? p : null;
}

/** Hip centre, used as the thrower's position. */
export function bodyCenter(p: Pose | null): { x: number; y: number } | null {
  if (!p || !visible(p[LM.lHip], 0.3) || !visible(p[LM.rHip], 0.3)) return null;
  const m = mid(p[LM.lHip], p[LM.rHip]);
  return { x: m.x, y: m.y };
}

/** Lowest visible foot point (largest y) — a ground contact estimate. */
export function footY(p: Pose | null): number | null {
  if (!p) return null;
  const ys = [LM.lHeel, LM.rHeel, LM.lFoot, LM.rFoot, LM.lAnkle, LM.rAnkle]
    .filter((i) => visible(p[i], 0.5))
    .map((i) => p[i].y);
  return ys.length ? Math.max(...ys) : null;
}

/** Axis-aligned box around the visible body (with margin) — motion inside it is the athlete. */
export function bodyBox(p: Pose | null, marginFrac = 0.08) {
  if (!p) return null;
  const pts = p.filter((l) => l.v >= 0.4);
  if (pts.length < 8) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of pts) {
    x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x);
    y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y);
  }
  const m = Math.max(x1 - x0, y1 - y0) * marginFrac;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}
