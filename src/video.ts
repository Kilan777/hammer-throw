// Video loading, fps estimation and frame-accurate extraction by seeking.

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export async function loadVideo(file: File | string): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = typeof file === 'string' ? file : URL.createObjectURL(file);
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () => rej(new Error('This browser could not decode the video. Try an MP4 (H.264) or WebM file.'));
  });
  // Some containers (e.g. MediaRecorder WebM) report Infinity until we seek to the end.
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9;
    await once(v, 'seeked');
    v.currentTime = 0;
    await once(v, 'seeked');
  }
  return v;
}

function once(el: EventTarget, ev: string) {
  return new Promise<void>((res) => el.addEventListener(ev, () => res(), { once: true }));
}

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240];

/** Plays a short stretch muted and measures presented-frame spacing. Falls back to 30. */
export async function estimateFps(video: RVFCVideo): Promise<number> {
  if (!video.requestVideoFrameCallback) return 30;
  const times: number[] = [];
  const done = new Promise<void>((res) => {
    const cb = (_: number, meta: { mediaTime: number }) => {
      times.push(meta.mediaTime);
      if (times.length >= 25) res();
      else video.requestVideoFrameCallback!(cb);
    };
    video.requestVideoFrameCallback!(cb);
    setTimeout(res, 2500);
  });
  video.currentTime = 0;
  video.playbackRate = 0.5; // slower playback → fewer dropped frames while measuring
  try {
    await video.play();
  } catch {
    return 30;
  }
  await done;
  video.pause();
  video.playbackRate = 1;
  const d = times
    .slice(1)
    .map((t, i) => t - times[i])
    .filter((x) => x > 1e-4)
    .sort((a, b) => a - b);
  if (d.length < 4) return 30;
  // Smallest common spacing = true frame interval (larger ones are dropped frames).
  const dt = d[Math.floor(d.length * 0.2)];
  const fps = 1 / dt;
  const nearest = COMMON_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  return Math.abs(nearest - fps) / nearest < 0.04 ? nearest : Math.round(fps * 100) / 100;
}

export interface ExtractedFrame {
  index: number;
  t: number; // media time (s)
  seekT: number; // the time we seeked to; re-seeking here shows this exact frame
}

/** Seek to a time and resolve once the frame is painted, returning its media time if known. */
export async function seekTo(video: RVFCVideo, time: number): Promise<number> {
  let mediaTime: number | null = null;
  let handle = 0;
  const painted = new Promise<void>((res) => {
    if (!video.requestVideoFrameCallback) return res();
    handle = video.requestVideoFrameCallback((_, meta) => {
      mediaTime = meta.mediaTime;
      res();
    });
  });
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 1e-3));
  if (Math.abs(video.currentTime - target) < 1e-6) {
    if (handle) video.cancelVideoFrameCallback?.(handle);
    return target;
  }
  video.currentTime = target;
  await once(video, 'seeked');
  // rVFC doesn't fire if the seek landed on the frame already shown; don't wait forever.
  await Promise.race([painted, new Promise((r) => setTimeout(r, 120))]);
  if (mediaTime === null && handle) video.cancelVideoFrameCallback?.(handle);
  return mediaTime ?? target;
}

/**
 * Steps through [start, end] one frame at a time, calling `onFrame` with the video positioned
 * on each new frame. Duplicate frames (same media time) are skipped.
 */
export async function extractFrames(
  video: RVFCVideo,
  start: number,
  end: number,
  fps: number,
  onFrame: (f: ExtractedFrame) => Promise<void> | void,
  onProgress?: (p: number) => void,
  signal?: { cancelled: boolean },
): Promise<ExtractedFrame[]> {
  const out: ExtractedFrame[] = [];
  const n = Math.max(1, Math.round((end - start) * fps));
  let lastT = -1;
  for (let i = 0; i < n; i++) {
    if (signal?.cancelled) break;
    // Aim at the middle of the frame interval so rounding never lands on a neighbour.
    const seekT = start + (i + 0.5) / fps;
    const t = await seekTo(video, seekT);
    if (Math.abs(t - lastT) < 0.25 / fps) continue;
    lastT = t;
    const f = { index: out.length, t, seekT };
    await onFrame(f);
    out.push(f);
    onProgress?.((i + 1) / n);
  }
  return out;
}
