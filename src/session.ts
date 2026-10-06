// A "session" is everything needed to reopen a marked throw instantly: settings, ball points,
// and (optionally) the cached per-frame analysis so pose/motion detection needn't run again.
// Demos ship as video + session; users can save their own with “Save markings”.

import type { FrameRecord, Setup } from './analyze';
import type { Candidate } from './motion';
import type { TrackPoint } from './track';

export interface SessionFrame {
  frame: number;
  t: number;
  seekT: number;
  pose: [number, number, number][] | null; // x, y, visibility (analysis px)
  cands: [number, number, number, number][]; // x, y, area, strength
  off?: [number, number]; // camera offset vs reference frame
}

export interface Session {
  version: 1;
  title?: string;
  video?: string; // URL, for demos
  fps: number;
  range: [number, number];
  W: number;
  H: number;
  setup: Partial<Setup>;
  track: TrackPoint[];
  frames?: SessionFrame[];
  /** Known answer, if any (synthetic truth, or an official competition mark). */
  reference?: { distance: number; label: string };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

// Settings that describe this particular video (not the user's general preferences).
const SESSION_SETUP_KEYS: (keyof Setup)[] = [
  'cameraDistance', 'distanceSigma', 'hfovDeg', 'scaleMode', 'hammerIndex', 'cd', 'rho', 'groundLine',
  'circleEdge', 'releaseFrame', 'psiMode', 'psiDeg', 'hand', 'releaseRadius', 'pitchDeg', 'calib', 'timeScale', 'throwerHeight',
];

export function buildSession(o: {
  fps: number;
  range: [number, number];
  W: number;
  H: number;
  setup: Setup;
  track: TrackPoint[];
  frames: FrameRecord[];
  seekT: number[];
  includeFrames: boolean;
  title?: string;
  reference?: Session['reference'];
}): Session {
  const setup: Partial<Setup> = {};
  for (const k of SESSION_SETUP_KEYS) (setup as Record<string, unknown>)[k] = o.setup[k];
  return {
    version: 1,
    title: o.title,
    fps: o.fps,
    range: o.range,
    W: o.W,
    H: o.H,
    setup,
    track: o.track.map((p) => ({ frame: p.frame, t: r4(p.t), x: r2(p.x), y: r2(p.y), manual: p.manual })),
    frames: o.includeFrames
      ? o.frames.map((f, i) => ({
          frame: f.frame,
          t: r4(f.t),
          seekT: r4(o.seekT[i]),
          pose: f.pose ? f.pose.map((l) => [r1(l.x), r1(l.y), r2(l.v)] as [number, number, number]) : null,
          cands: f.cands.map((c) => [r1(c.x), r1(c.y), c.area, Math.round(c.strength)] as [number, number, number, number]),
          off: f.off && (f.off.x || f.off.y) ? ([r2(f.off.x), r2(f.off.y)] as [number, number]) : undefined,
        }))
      : undefined,
    reference: o.reference,
  };
}

export function sessionFrames(s: Session): { frames: FrameRecord[]; seekT: number[] } | null {
  if (!s.frames?.length) return null;
  return {
    frames: s.frames.map((f) => ({
      frame: f.frame,
      t: f.t,
      pose: f.pose ? f.pose.map(([x, y, v]) => ({ x, y, v })) : null,
      cands: f.cands.map(([x, y, area, strength]): Candidate => ({ x, y, area, strength, w: 0, h: 0 })),
      off: f.off ? { x: f.off[0], y: f.off[1] } : undefined,
    })),
    seekT: s.frames.map((f) => f.seekT),
  };
}

export function parseSession(text: string): Session {
  const s = JSON.parse(text);
  if (s?.version !== 1 || !Array.isArray(s.track) || typeof s.W !== 'number') throw new Error('Not a hammer-throw markings file.');
  return s as Session;
}

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
