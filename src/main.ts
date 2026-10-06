import { analyze, autoGround, cameraPpm, DEFAULT_SETUP, statureFromPose, type FrameRecord, type Result, type Setup } from './analyze';
import { renderFlightChart } from './chart';
import { DEFAULT_MOTION, detectCandidates, motionImage, motionThreshold } from './motion';
import { HAMMERS } from './physics';
import { bodyBox, bodyCenter, createPoseDetector, detectPose, plausiblePose } from './pose';
import { drawOverlay, COLORS } from './overlay';
import { renderTopView } from './topview';
import { findTrack, type TrackPoint } from './track';
import { estimateFps, extractFrames, loadVideo, seekTo } from './video';
import { buildSession, downloadJson, parseSession, sessionFrames, type Session } from './session';
import { runTour, type TourStep } from './tour';
import { calibrateFromCircle, circleOutline } from './calib';
import { focalPx } from './analyze';
import { project, type Cam } from './fit3d';
import { computeOffsets, shiftImage } from './stab';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Tool = 'none' | 'ball' | 'ground' | 'edge' | 'calib';

const app = {
  video: null as HTMLVideoElement | null,
  thumbVideo: null as HTMLVideoElement | null,
  src: '',
  fps: 30,
  W: 640,
  H: 360,
  frames: [] as FrameRecord[],
  seekT: [] as number[],
  grays: [] as Uint8Array[],
  track: [] as TrackPoint[],
  setup: { ...DEFAULT_SETUP } as Setup,
  result: null as Result | { error: string } | null,
  cur: 0,
  previewT: 0,
  tool: 'none' as Tool,
  pendingGround: null as { x: number; y: number } | null,
  calibClicks: [] as { x: number; y: number }[],
  busy: false,
  sens: DEFAULT_MOTION.minThreshold,
  name: 'throw', // used for saved file names
  range: [0, 0] as [number, number],
  reference: null as Session['reference'] | null,
};


let poseDet: PoseLandmarker | null = null;
let poseTs = 0; // VIDEO mode needs strictly increasing timestamps across runs
const cancelToken = { cancelled: false };

// ---------- persistence ----------
const STORE = 'hammer-throw-setup-v1';
function saveSetup() {
  try {
    const { cameraDistance, hfovDeg, scaleMode, hammerIndex, cd, rho, hand, releaseRadius, distanceSigma, throwerHeight } = app.setup;
    localStorage.setItem(STORE, JSON.stringify({ cameraDistance, hfovDeg, scaleMode, hammerIndex, cd, rho, hand, releaseRadius, distanceSigma, throwerHeight }));
  } catch { /* storage unavailable */ }
}
function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (s) Object.assign(app.setup, s);
  } catch { /* ignore */ }
}

// ---------- setup form ----------
const hammerSel = $<HTMLSelectElement>('hammer');
HAMMERS.forEach((h, i) => hammerSel.add(new Option(h.label, String(i))));

function syncForm() {
  const s = app.setup;
  $<HTMLInputElement>('cam-dist').value = String(s.cameraDistance);
  $<HTMLInputElement>('fov').value = String(s.hfovDeg);
  const preset = $<HTMLSelectElement>('fov-preset');
  const match = [...preset.options].find((o) => o.value === String(s.hfovDeg));
  preset.value = match ? match.value : 'custom';
  $('fov-custom-row').hidden = preset.value !== 'custom';
  $<HTMLSelectElement>('scale-mode').value = s.scaleMode;
  $('height-row').hidden = s.scaleMode !== 'height';
  $<HTMLInputElement>('thrower-height').value = String(s.throwerHeight);
  hammerSel.value = String(s.hammerIndex);
  $<HTMLInputElement>('cd').value = String(s.cd);
  $<HTMLInputElement>('rho').value = String(s.rho);
  $<HTMLInputElement>('fps').value = String(app.fps);
  $<HTMLSelectElement>('hand').value = s.hand;
  $<HTMLInputElement>('rel-radius').value = String(s.releaseRadius);
  $<HTMLInputElement>('dist-sigma').value = String(s.distanceSigma);
  const sm = $<HTMLSelectElement>('slowmo');
  const smMatch = [...sm.options].find((o) => o.value !== 'custom' && Math.abs(parseFloat(o.value) - s.timeScale) < 1e-6);
  sm.value = smMatch ? smMatch.value : 'custom';
  $('slowmo-custom-row').hidden = sm.value !== 'custom';
  $<HTMLInputElement>('slowmo-pct').value = String(Math.round(s.timeScale * 1000) / 10);
  $('calib-status').hidden = !s.calib;
  if (s.calib)
    $('calib-text').textContent = `Calibrated from circle · camera ${s.calib.H.toFixed(2)} m high, tilted ${s.pitchDeg.toFixed(1)}° down`;
  syncPsi();
}
function setTimeScale(k: number) {
  app.setup.timeScale = Math.min(1, Math.max(0.005, k));
  syncForm();
  recompute();
}
$<HTMLSelectElement>('slowmo').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  $('slowmo-custom-row').hidden = v !== 'custom';
  if (v !== 'custom') setTimeScale(parseFloat(v));
});
$<HTMLInputElement>('slowmo-pct').addEventListener('change', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 0) setTimeScale(v / 100);
});
$('calib-clear').addEventListener('click', () => {
  app.setup.calib = null;
  app.setup.pitchDeg = 0;
  syncForm();
  recompute();
  render();
});

function syncPsi() {
  const s = app.setup;
  document.querySelectorAll<HTMLButtonElement>('#psi-mode button').forEach((b) => b.classList.toggle('on', b.dataset.psi === s.psiMode));
  const inp = $<HTMLInputElement>('psi');
  const r = app.result;
  inp.value = s.psiMode === 'auto' && r && !('error' in r) ? r.psi.toFixed(1) : String(s.psiDeg);
}

function bindNumber(id: string, apply: (v: number) => void) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v)) {
      apply(v);
      saveSetup();
      recompute();
    }
  });
}
bindNumber('cam-dist', (v) => {
  app.setup.cameraDistance = Math.max(0.5, v);
  app.setup.calib = null; // typed by hand → the circle calibration no longer applies
});
bindNumber('fov', (v) => {
  app.setup.hfovDeg = v;
  app.setup.calib = null;
});
bindNumber('cd', (v) => (app.setup.cd = v));
bindNumber('rho', (v) => (app.setup.rho = v));
bindNumber('fps', (v) => (app.fps = v));
bindNumber('rel-radius', (v) => (app.setup.releaseRadius = Math.max(0, v)));
bindNumber('dist-sigma', (v) => (app.setup.distanceSigma = Math.max(0.05, v)));
bindNumber('psi', (v) => {
  app.setup.psiMode = 'manual';
  app.setup.psiDeg = Math.max(-60, Math.min(60, v));
});
$<HTMLSelectElement>('hand').addEventListener('change', (e) => {
  app.setup.hand = (e.target as HTMLSelectElement).value as Setup['hand'];
  saveSetup();
  recompute();
});
document.querySelectorAll<HTMLButtonElement>('#psi-mode button').forEach((b) =>
  b.addEventListener('click', () => {
    const r = app.result;
    // Switching to manual starts from the current auto estimate.
    if (b.dataset.psi === 'manual' && app.setup.psiMode === 'auto' && r && !('error' in r)) app.setup.psiDeg = Math.round(r.psi * 2) / 2;
    app.setup.psiMode = b.dataset.psi as Setup['psiMode'];
    recompute();
  }),
);
$<HTMLSelectElement>('fov-preset').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  $('fov-custom-row').hidden = v !== 'custom';
  if (v !== 'custom') {
    app.setup.hfovDeg = parseFloat(v);
    app.setup.calib = null;
    $<HTMLInputElement>('fov').value = v;
    saveSetup();
    recompute();
  }
});
$<HTMLSelectElement>('scale-mode').addEventListener('change', (e) => {
  app.setup.scaleMode = (e.target as HTMLSelectElement).value as Setup['scaleMode'];
  $('height-row').hidden = app.setup.scaleMode !== 'height';
  saveSetup();
  recompute();
});
bindNumber('thrower-height', (v) => (app.setup.throwerHeight = Math.min(2.4, Math.max(1, v))));
hammerSel.addEventListener('change', () => {
  app.setup.hammerIndex = parseInt(hammerSel.value, 10);
  saveSetup();
  recompute();
});
$<HTMLInputElement>('sens').addEventListener('change', (e) => {
  app.sens = parseInt((e.target as HTMLInputElement).value, 10);
  if (app.frames.length) retrack();
});
$('t-start-here').addEventListener('click', () => {
  $<HTMLInputElement>('t-start').value = currentTime().toFixed(2);
});
$('t-end-here').addEventListener('click', () => {
  $<HTMLInputElement>('t-end').value = currentTime().toFixed(2);
});

// ---------- loading ----------
async function openVideo(src: File | string, preset?: Partial<Setup>) {
  try {
    pause();
    $('credit').hidden = true;
    app.reference = null;
    app.name = typeof src === 'string' ? src.split('/').pop()!.replace(/\.[^.]+$/, '') : src.name.replace(/\.[^.]+$/, '');
    showBusy('Loading video…', 0);
    app.video?.pause();
    const v = await loadVideo(src);
    app.video = v;
    app.src = v.src;
    app.thumbVideo = await loadVideo(v.src);
    // Analysis resolution: ≤640 px wide keeps detection fast; coordinates everywhere are in this space.
    app.W = Math.min(640, v.videoWidth);
    app.H = Math.round((app.W * v.videoHeight) / v.videoWidth);
    app.frames = [];
    app.grays = [];
    app.seekT = [];
    app.track = [];
    app.result = null;
    app.setup.groundLine = null;
    app.setup.circleEdge = null;
    app.setup.releaseFrame = null;
    app.setup.psiMode = 'auto';
    app.setup.calib = null;
    app.setup.pitchDeg = 0;
    app.setup.timeScale = 1;
    if (preset) Object.assign(app.setup, preset);
    showBusy('Measuring frame rate…', 0);
    app.fps = await estimateFps(v);
    await seekTo(v, 0);
    app.previewT = 0;
    syncForm();
    $<HTMLInputElement>('t-start').value = '0';
    $<HTMLInputElement>('t-end').value = v.duration.toFixed(2);
    $('drop').hidden = true;
    $('viewer').hidden = false;
    $<HTMLButtonElement>('analyze').disabled = false;
    for (const id of ['result-card', 'body-card', 'scale-card', 'strip-card', 'chart-card', 'geo-card']) $(id).hidden = true;
    configureScrub();
    resizeCanvas();
    syncCachedUi();
    hideBusy();
    render();
    return true;
  } catch (e) {
    hideBusy();
    alert((e as Error).message);
    return false;
  }
}

for (const id of ['file', 'file2']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) openVideo(f);
  });
}
// ---------- demos ----------
interface DemoEntry {
  id: string;
  title: string;
  kind: 'synthetic' | 'real';
  video: string;
  session?: string;
  note?: string;
  credit?: { text: string; url?: string };
}
let demos: DemoEntry[] = [];
const demosReady = fetch('demo/index.json')
  .then((r) => r.json())
  .then((d: DemoEntry[]) => (demos = d))
  .catch(() => (demos = []))
  .then(buildDemoMenu);

function buildDemoMenu() {
  const menu = $('demo-menu');
  menu.innerHTML = '';
  for (const d of demos) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `<b>${d.title}<i class="kind ${d.kind}">${d.kind}</i></b>${d.note ? `<span>${d.note}</span>` : ''}`;
    b.addEventListener('click', () => {
      toggleDemoMenu(false);
      openDemo(d);
    });
    menu.append(b);
  }
}
function toggleDemoMenu(open = $('demo-menu').hidden) {
  $('demo-menu').hidden = !open;
  $('demo').setAttribute('aria-expanded', String(open));
}
$('demo').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDemoMenu();
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.menu-wrap')) toggleDemoMenu(false);
});

async function openDemo(d?: DemoEntry) {
  await demosReady;
  // ?demo=<id> picks a demo by id; otherwise the first one listed.
  const want = new URLSearchParams(location.search).get('demo');
  d ??= demos.find((x) => x.id === want) ?? demos[0];
  if (!d) return alert('No demos found in /demo/index.json.');
  if (!(await openVideo(d.video))) return;
  app.name = d.id;
  const cr = $('credit');
  cr.hidden = !d.credit;
  if (d.credit) cr.innerHTML = d.credit.url ? `<a href="${d.credit.url}" target="_blank" rel="noopener">${d.credit.text}</a>` : d.credit.text;
  if (d.session) {
    try {
      await applySession(parseSession(await (await fetch(d.session)).text()));
    } catch (e) {
      alert(`Couldn't load the demo's markings: ${(e as Error).message}`);
    }
  }
}
$('demo2').addEventListener('click', () => openDemo());

// ---------- sessions (save / load markings) ----------
async function applySession(sess: Session) {
  if (!app.video) throw new Error('Open the matching video first.');
  if (Math.abs(sess.W - app.W) > 1 || Math.abs(sess.H - app.H) > 1)
    throw new Error(`These markings were made on a ${sess.W}×${sess.H} analysis of a different video.`);
  Object.assign(app.setup, sess.setup);
  app.fps = sess.fps;
  app.reference = sess.reference ?? null;
  $<HTMLInputElement>('t-start').value = String(sess.range[0]);
  $<HTMLInputElement>('t-end').value = String(sess.range[1]);
  const cached = sessionFrames(sess);
  if (cached) {
    // Cached analysis: no need to re-run pose + motion detection.
    app.frames = cached.frames;
    app.seekT = cached.seekT;
    app.grays = [];
    app.range = sess.range;
  } else {
    await runAnalysis();
  }
  app.track = sess.track.map((p) => ({ ...p }));
  Object.assign(app.setup, sess.setup); // runAnalysis resets the release frame
  syncForm();
  configureScrub();
  recompute();
  syncCachedUi();
  const r = app.result;
  await showFrame(r && !('error' in r) ? r.releaseFrame : 0);
}

/** Without the raw frames (loaded from cache), motion-detection tools can't run. */
function syncCachedUi() {
  const cached = app.frames.length > 0 && app.grays.length === 0;
  const why = cached ? 'Loaded from saved markings — click “Analyze throw” to re-run detection' : '';
  for (const id of ['retrack', 'show-mask']) {
    const el = $<HTMLButtonElement | HTMLInputElement>(id);
    el.disabled = cached;
    el.title = why;
  }
  if (cached) $<HTMLInputElement>('show-mask').checked = showMask = false;
}

$('save-session').addEventListener('click', () => {
  if (!app.frames.length) return alert('Analyze the video first.');
  downloadJson(
    `${app.name}-markings.json`,
    buildSession({
      fps: app.fps, range: app.range, W: app.W, H: app.H, setup: app.setup, track: app.track,
      frames: app.frames, seekT: app.seekT, includeFrames: true, title: app.name,
      reference: app.reference ?? undefined,
    }),
  );
});
$<HTMLInputElement>('load-session').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const sess = parseSession(await f.text());
    if (!app.video) {
      if (!sess.video) return alert('Open the video these markings belong to first, then load them.');
      if (!(await openVideo(sess.video))) return;
    }
    await applySession(sess);
  } catch (err) {
    alert((err as Error).message);
  }
});

const drop = $('drop');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
window.addEventListener('dragleave', () => drop.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('video')) openVideo(f);
});

// ---------- analysis ----------
function toGray(img: ImageData): Uint8Array {
  const d = img.data;
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

async function runAnalysis() {
  const v = app.video;
  if (!v || app.busy) return;
  pause();
  app.busy = true;
  cancelToken.cancelled = false;
  try {
    if (!poseDet) {
      showBusy('Loading pose model…', 0);
      try {
        poseDet = await createPoseDetector();
      } catch (e) {
        console.warn('pose model failed to load', e);
      }
    }
    const start = Math.max(0, parseFloat($<HTMLInputElement>('t-start').value) || 0);
    const endIn = parseFloat($<HTMLInputElement>('t-end').value);
    const end = Math.min(v.duration, Number.isFinite(endIn) && endIn > start ? endIn : v.duration);
    app.range = [Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000];
    const { W, H } = app;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    // Square, letterboxed copy of each frame for the pose model.
    const S = Math.min(960, Math.max(v.videoWidth, v.videoHeight));
    const sq = document.createElement('canvas');
    sq.width = sq.height = S;
    const sqx = sq.getContext('2d')!;
    const fitScale = S / Math.max(v.videoWidth, v.videoHeight);
    const sqW = v.videoWidth * fitScale, sqH = v.videoHeight * fitScale;
    const frames: FrameRecord[] = [];
    const grays: Uint8Array[] = [];
    const seekT: number[] = [];
    const total = Math.round((end - start) * app.fps);
    await extractFrames(
      v,
      start,
      end,
      app.fps,
      (f) => {
        cx.drawImage(v, 0, 0, W, H);
        grays.push(toGray(cx.getImageData(0, 0, W, H)));
        let pose = null;
        if (poseDet) {
          try {
            poseTs += 1000 / app.fps;
            sqx.fillStyle = '#000';
            sqx.fillRect(0, 0, S, S);
            sqx.drawImage(v, 0, 0, sqW, sqH);
            pose = plausiblePose(detectPose(poseDet, sq, Math.round(poseTs), W / sqW));
          } catch (e) {
            console.warn(e);
          }
        }
        frames.push({ frame: f.index, t: f.t, pose, cands: [] });
        seekT.push(f.seekT);
      },
      (p) => showBusy(`Reading frames + pose… ${Math.round(p * total)}/${total}`, p * 0.85),
      cancelToken,
    );
    if (cancelToken.cancelled || frames.length < 5) {
      if (!cancelToken.cancelled) alert('Not enough frames in the selected range.');
      return;
    }
    app.frames = frames;
    app.grays = grays;
    app.seekT = seekT;
    app.setup.releaseFrame = null;
    showBusy('Checking for camera movement…', 0.88);
    await new Promise((r) => setTimeout(r, 20));
    const offs = computeOffsets(grays, W, H, (i) => { const b = bodyBox(frames[i].pose); return b ? [b] : []; });
    frames.forEach((f, i) => (f.off = offs[i]));
    showBusy('Finding the hammer…', 0.92);
    await new Promise((r) => setTimeout(r, 20));
    detectAllCandidates();
    app.track = autoTrack();
    configureScrub();
    recompute();
    syncCachedUi();
    const r = app.result;
    const target = r && !('error' in r) ? r.releaseFrame : 0;
    hideBusy();
    await showFrame(target);
  } finally {
    app.busy = false;
    hideBusy();
  }
}

function detectAllCandidates() {
  const { frames, grays, W, H } = app;
  const opts = { ...DEFAULT_MOTION, minThreshold: app.sens };
  for (let i = 0; i < frames.length; i++) {
    if (i === 0 || i === frames.length - 1) {
      frames[i].cands = [];
      continue;
    }
    const box = bodyBox(frames[i].pose);
    // If the camera moved, line the neighbours up with this frame before differencing.
    const o = (j: number) => frames[j].off ?? { x: 0, y: 0 };
    const al = (j: number) => shiftImage(grays[j], W, H, Math.round(o(i).x - o(j).x), Math.round(o(i).y - o(j).y));
    frames[i].cands = detectCandidates(al(i - 1), grays[i], al(i + 1), W, H, box ? [box] : [], opts);
  }
}

function autoTrack(): TrackPoint[] {
  const { frames, W, H, fps } = app;
  // Track in real time so the physical speed/gravity limits hold for slow-motion clips too.
  const k = app.setup.timeScale || 1;
  // Track in the stabilized reference frame (a moving camera bends raw paths), then map back.
  const o = (f: FrameRecord) => f.off ?? { x: 0, y: 0 };
  return findTrack(
    frames.map((f) => {
      const b = bodyCenter(f.pose);
      return {
        frame: f.frame,
        t: f.t * k,
        cands: f.cands.map((c) => ({ ...c, x: c.x - o(f).x, y: c.y - o(f).y })),
        body: b && { x: b.x - o(f).x, y: b.y - o(f).y },
      };
    }),
    { W, H, fps: fps / k, ppm: trackerPpm() },
  ).map((p) => {
    const f = app.frames[p.frame];
    return { ...p, t: f.t, x: p.x + o(f).x, y: p.y + o(f).y };
  });
}

/** Rough pixels-per-metre at the thrower, for the tracker's physical limits. */
function trackerPpm(): number | null {
  const s = app.setup;
  if (s.calib) return focalPx(app.W, s.hfovDeg) / Math.hypot(s.calib.C.x, s.calib.C.z);
  if (s.scaleMode === 'camera') return cameraPpm(app.W, s);
  if (s.scaleMode === 'height') {
    const px = statureFromPose(app.frames);
    return px ? px / s.throwerHeight : null;
  }
  return null;
}

function retrack() {
  if (!app.frames.length) return;
  detectAllCandidates();
  app.track = autoTrack();
  app.setup.releaseFrame = null;
  recompute();
  const r = app.result;
  if (r && !('error' in r)) showFrame(r.releaseFrame);
}

let recomputeQueued = false;
function scheduleRecompute() {
  if (recomputeQueued) return;
  recomputeQueued = true;
  requestAnimationFrame(() => {
    recomputeQueued = false;
    recompute();
  });
}

function recompute() {
  if (!app.frames.length) return;
  app.result = analyze(app.frames, app.track, app.setup, app.W, app.H);
  updatePanels();
  updateMarkers();
  renderStrip();
  render();
}

$('analyze').addEventListener('click', runAnalysis);
$('cancel').addEventListener('click', () => (cancelToken.cancelled = true));
$('retrack').addEventListener('click', retrack);

// ---------- results panels ----------
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pm = (v: number, d = 1) => (v > 0 ? ` <small>±${v.toFixed(d)}</small>` : '');

function updatePanels() {
  const r = app.result;
  $('result-card').hidden = false;
  const warn = $('r-warn');
  warn.innerHTML = '';
  const addWarn = (t: string, cls = '') => {
    const li = document.createElement('li');
    li.textContent = t;
    if (cls) li.className = cls;
    warn.append(li);
  };
  if (!r || 'error' in r) {
    $('r-ref').hidden = true;
    $('r-dist').textContent = '–';
    $('r-dist-sub').textContent = 'no trajectory yet';
    for (const id of ['r-speed', 'r-angle', 'r-height', 'r-vac', 'r-time', 'r-apex']) $(id).textContent = '–';
    $('r-hint').textContent = '';
    addWarn(r && 'error' in r ? r.error : 'The hammer could not be found automatically. Use “Mark ball” to click it in 3+ frames after release.', 'err');
    for (const id of ['body-card', 'scale-card', 'chart-card', 'geo-card']) $(id).hidden = true;
    $('strip-card').hidden = app.track.length === 0;
    return;
  }
  $('r-dist').textContent = fmt(r.distDrag);
  const ref = app.reference;
  $('r-ref').hidden = !ref;
  if (ref) {
    const d = r.distDrag - ref.distance;
    $('r-ref').innerHTML = `Known answer: <b>${fmt(ref.distance, 2)} m</b> (${ref.label}) · this estimate is ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} m`;
  }
  $('r-dist-sub').innerHTML =
    `predicted distance${r.unc.dist > 0 ? ` · ±${fmt(r.unc.dist)} m` : ''} · ` +
    (app.setup.circleEdge ? 'from circle edge' : 'from release point');
  $('r-speed').innerHTML = `${fmt(r.speed)} m/s${pm(r.unc.speed)}<br><small>${fmt(r.speed * 3.6, 0)} km/h</small>`;
  $('r-angle').innerHTML = `${fmt(r.angle)}°${pm(r.unc.angle)}`;
  $('r-height').innerHTML = `${fmt(r.height, 2)} m${pm(r.unc.height, 2)}`;
  $('r-vac').textContent = `${fmt(r.distVac)} m`;
  $('r-time').textContent = `${fmt(r.flightTime, 2)} s`;
  $('r-apex').textContent = `${fmt(r.apex)} m`;
  $('r-hint').textContent = `Best angle for this speed and height ≈ ${fmt(r.optimalAngle)}° without drag (a degree or two lower with drag).`;
  r.warnings.forEach((w) => addWarn(w));

  // Body
  const b = r.body && Object.values(r.body).some((v) => v !== undefined) ? r.body : null;
  $('body-card').hidden = !b;
  if (b) {
    const row = (k: string, v: number | undefined, note = '') =>
      `<div><dt>${k}</dt><dd>${v === undefined ? '–' : `${v.toFixed(0)}°`}${note ? ` <small>${note}</small>` : ''}</dd></div>`;
    $('body').innerHTML =
      row('Left knee', b.lKnee) + row('Right knee', b.rKnee) +
      row('Left elbow', b.lElbow) + row('Right elbow', b.rElbow) +
      row('Trunk lean', b.trunkLean, b.trunkLean === undefined ? '' : b.trunkLean > 0 ? 'back' : 'forward') +
      `<div><dt>Frame</dt><dd>#${r.bodyFrame}</dd></div>`;
  }

  // Measurement check
  $('scale-card').hidden = false;
  const s = app.setup;
  let gTxt = '<small>needs 5+ points</small>';
  if (r.gravityDepth) {
    const { est, sd } = r.gravityDepth;
    if (s.scaleMode === 'gravity') gTxt = `${fmt(est)} m <small>±${fmt(sd)} · used as the scale</small>`;
    else if (sd > 0.3 * est) gTxt = `${fmt(est)} m <small>±${fmt(sd)}</small><br><small>Too few frames to check depth from gravity at this frame rate — slow-mo makes this much tighter.</small>`;
    else {
      const ok = Math.abs(est - r.depth) <= Math.max(2.5 * sd, 0.15 * r.depth);
      gTxt = `${fmt(est)} m <small>±${fmt(sd)}</small> <small class="${ok ? 'good' : 'bad'}">${ok ? '✓ agrees with setup' : 'disagrees with setup — check distance/FOV/hand'}</small>`;
    }
  }
  const nManual = app.track.filter((p) => p.manual).length;
  const sug = r.suggestedTimeScale;
  const sugTxt =
    sug && Math.abs(sug / r.timeScale - 1) > 0.15
      ? `<div><dt>Video speed check (gravity)</dt><dd>${fmt(sug * 100, 1)}% <small class="bad">of real speed — you have ${fmt(r.timeScale * 100, 1)}%</small> <button class="btn tiny ghost" id="use-sug">use</button></dd></div>`
      : sug
        ? `<div><dt>Video speed check (gravity)</dt><dd>${fmt(sug * 100, 1)}% <small class="good">✓ consistent with ${fmt(r.timeScale * 100, 1)}%</small></dd></div>`
        : '';
  const driftTxt = r.cameraDrift > 1 ? `<div><dt>Camera movement</dt><dd>${fmt(r.cameraDrift, 0)} px <small>detected and compensated</small></dd></div>` : '';
  $('scale').innerHTML = sugTxt + driftTxt + `
    <div><dt>Ball's distance from camera</dt><dd>${fmt(r.depth)} m <small>${s.scaleMode === 'gravity' ? 'from gravity' : `thrower at ${fmt(Math.hypot(r.geo.A.x, r.geo.A.z))} m${s.calib ? ' (circle calibration)' : s.scaleMode === 'height' ? ' (from thrower height)' : ''}, flight line ${fmt(Math.abs(r.lateral), 1)} m ${r.lateral * r.dir >= 0 ? 'nearer' : 'farther'}`}</small></dd></div>
    <div><dt>Same, from gravity alone</dt><dd>${gTxt}</dd></div>
    <div><dt>If camera distance is 10% off</dt><dd>${s.scaleMode === 'gravity' ? '<small>n/a in gravity mode</small>' : `±${fmt(r.scaleSens)} m <small>distance change</small>`}</dd></div>
    <div><dt>Ball positions used</dt><dd>${app.track.length - r.excluded.length} <small>${r.excluded.length ? `${r.excluded.length} ignored · ` : ''}${nManual ? `${nManual} manual · ` : ''}arc fit ${fmt(r.fit.rmsPx, 1)} px · ${fmt(app.fps, 2)} fps · ${fmt(r.pxPerMetreAtThrower, 1)} px/m at thrower</small></dd></div>`;

  $('use-sug')?.addEventListener('click', () => setTimeScale(Math.round(sug! * 1000) / 1000));

  // Geometry
  $('geo-card').hidden = false;
  renderTopView($('topview'), r, {
    hfovDeg: s.hfovDeg,
    onDragPsi: (psi) => {
      app.setup.psiMode = 'manual';
      app.setup.psiDeg = psi;
      scheduleRecompute();
    },
  });
  const side = r.lateral >= 0 ? 'right' : 'left';
  $('geo-stats').innerHTML = `
    <div><dt>Throw direction</dt><dd>${fmt(Math.abs(r.psi))}°${r.psiAuto ? pm(r.unc.psi) : ''} <small>${Math.abs(r.psi) < 0.5 ? 'square-on' : r.psi > 0 ? 'away from camera' : 'toward camera'} · ${r.psiAuto ? 'auto' : 'manual'}</small></dd></div>
    <div><dt>Flight line</dt><dd>${fmt(Math.abs(r.lateral), 2)} m <small>to thrower's ${side}</small></dd></div>
    <div><dt>Camera height</dt><dd>${fmt(r.geo.camHeight, 2)} m <small>from ground line</small></dd></div>
    <div><dt>Release → camera</dt><dd>${fmt(r.depth)} m</dd></div>`;
  syncPsi();

  $('chart-card').hidden = false;
  $('chart-note').textContent = app.setup.circleEdge ? 'x = 0 at circle edge' : 'x = 0 below release point';
  renderFlightChart($('chart'), r);
}

// ---------- viewer ----------
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const scrub = $<HTMLInputElement>('scrub');
let showSkel = true, showArc = true, showCands = false, showMask = false;

function resizeCanvas() {
  const v = app.video;
  if (!v) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(Math.min(canvas.clientWidth || 900, 1600) * dpr);
  canvas.width = cw;
  canvas.height = Math.round((cw * v.videoHeight) / v.videoWidth);
  render();
}
new ResizeObserver(() => resizeCanvas()).observe($('viewer'));

const analyzed = () => app.frames.length > 0;
function currentTime() {
  return analyzed() ? app.frames[app.cur]?.t ?? 0 : app.previewT;
}

function configureScrub() {
  if (analyzed()) {
    scrub.max = String(app.frames.length - 1);
    scrub.step = '1';
    scrub.value = String(app.cur = Math.min(app.cur, app.frames.length - 1));
  } else if (app.video) {
    scrub.max = String(Math.max(0, Math.floor(app.video.duration * app.fps) - 1));
    scrub.step = '1';
    scrub.value = '0';
  }
  updateMarkers();
}

// Latest-wins seeking so fast scrubbing doesn't queue up dozens of seeks.
let seekBusy = false;
let wantT = 0;
async function seekView(t: number) {
  wantT = t;
  if (seekBusy || !app.video) return;
  seekBusy = true;
  try {
    for (;;) {
      const target = wantT;
      await seekTo(app.video, target);
      if (target === wantT) break;
    }
  } finally {
    seekBusy = false;
  }
  render();
}

async function showFrame(i: number) {
  if (analyzed()) {
    app.cur = Math.max(0, Math.min(app.frames.length - 1, i));
    scrub.value = String(app.cur);
    await seekView(app.seekT[app.cur]);
  } else if (app.video) {
    const n = Math.floor(app.video.duration * app.fps);
    const k = Math.max(0, Math.min(n - 1, i));
    scrub.value = String(k);
    app.previewT = (k + 0.5) / app.fps;
    await seekView(app.previewT);
  }
  renderStripSelection();
}

scrub.addEventListener('input', () => {
  pause();
  showFrame(parseInt(scrub.value, 10));
});
$('prev').addEventListener('click', () => {
  pause();
  showFrame(parseInt(scrub.value, 10) - 1);
});
$('next').addEventListener('click', () => {
  pause();
  showFrame(parseInt(scrub.value, 10) + 1);
});

// ---------- playback ----------
// Plays the real video (slow-mo by default) with the overlays following along. After analysis it
// plays the analyzed stretch, unless “Full video” is ticked.
let playing = false;
const playBtn = $<HTMLButtonElement>('play');

/** Index of the analyzed frame showing at media time t (last frame starting at or before t). */
function frameAt(t: number) {
  const f = app.frames;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= t + 1e-4) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function playBounds(): [number, number] {
  const v = app.video!;
  if (!analyzed() || $<HTMLInputElement>('play-full').checked) return [0, v.duration];
  return [app.range[0], Math.min(v.duration, app.range[1])];
}

async function play() {
  const v = app.video;
  if (!v || playing) return;
  const [t0, t1] = playBounds();
  if (v.currentTime >= t1 - 0.05 || v.currentTime < t0) {
    v.currentTime = t0;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  }
  v.playbackRate = parseFloat($<HTMLSelectElement>('speed').value);
  playing = true;
  playBtn.textContent = '❚❚';
  playBtn.setAttribute('aria-label', 'Pause');
  try {
    await v.play();
  } catch {
    pause();
    return;
  }
  const tick = () => {
    if (!playing) return;
    const t = v.currentTime;
    if (t >= t1 - 1e-3 || v.ended) {
      pause();
      return;
    }
    if (analyzed()) {
      const inRange = t >= app.range[0] - 1e-3 && t <= app.range[1] + 1e-3;
      app.cur = frameAt(t);
      scrub.value = String(app.cur);
      // Outside the analyzed stretch there's nothing to annotate: show the plain video.
      renderPlaying(inRange);
    } else {
      app.previewT = t;
      scrub.value = String(Math.floor(t * app.fps));
      render();
    }
    requestFrame(tick);
  };
  requestFrame(tick);
}

type RVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
function requestFrame(cb: () => void) {
  const v = app.video as RVFC | null;
  if (v?.requestVideoFrameCallback) v.requestVideoFrameCallback(cb);
  else requestAnimationFrame(cb);
}

function pause() {
  if (!playing) return;
  playing = false;
  app.video?.pause();
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', 'Play');
  // Snap to a real analyzed frame so overlays and tools line up again.
  if (analyzed()) showFrame(app.cur);
  else render();
}

function renderPlaying(annotate: boolean) {
  if (annotate) return render();
  const v = app.video!;
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  $('frame-label').textContent = `${v.currentTime.toFixed(2)} s · outside analyzed part`;
}

playBtn.addEventListener('click', () => (playing ? pause() : play()));
$<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  if (app.video) app.video.playbackRate = parseFloat((e.target as HTMLSelectElement).value);
});

function render() {
  const v = app.video;
  if (!v || !canvas.width) return;
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  const k = canvas.width / app.W;
  const fr = analyzed() ? app.frames[app.cur] : null;

  if (showMask && fr && app.grays.length && app.cur > 0 && app.cur < app.frames.length - 1) drawMask(k);

  const r = app.result && !('error' in app.result) ? app.result : null;
  const ground = app.setup.groundLine ?? (analyzed() ? autoGround(app.frames, app.W) : null);
  drawOverlay(ctx, k, {
    frameIndex: fr ? app.cur : -1,
    frameT: currentTime(),
    pose: fr?.pose ?? null,
    cands: fr?.cands ?? [],
    track: app.track,
    result: r,
    ground,
    circleEdge: app.setup.circleEdge,
    showSkeleton: showSkel,
    showCands,
    showArc,
    pendingGround: app.pendingGround,
    ...calibOverlay(),
    off: fr?.off,
    offOf: (f: number) => app.frames[f]?.off ?? { x: 0, y: 0 },
  });
  $('frame-label').textContent = fr
    ? `frame ${app.cur}/${app.frames.length - 1} · ${fr.t.toFixed(3)} s`
    : `${app.previewT.toFixed(2)} / ${v.duration.toFixed(2)} s`;
}

function calibOverlay() {
  const s = app.setup;
  const out: { calibOutline?: { x: number; y: number }[]; horizon?: { x1: number; y1: number; x2: number; y2: number }; calibClicks?: { x: number; y: number }[] } = {};
  if (app.tool === 'calib') out.calibClicks = app.calibClicks;
  if (s.calib) {
    const cam = setupCam();
    out.calibOutline = circleOutline(cam, s.calib.H, s.calib.C);
    // Horizon: points at camera height, very far away.
    const a = project(cam, -1e5, 0, 1e5), b = project(cam, 1e5, 0, 1e5);
    const m = (b.y - a.y) / (b.x - a.x);
    out.horizon = { x1: 0, y1: a.y + m * (0 - a.x), x2: app.W, y2: a.y + m * (app.W - a.x) };
  }
  return out;
}

const maskCanvas = document.createElement('canvas');
function drawMask(k: number) {
  const i = app.cur;
  const m = motionImage(app.grays[i - 1], app.grays[i], app.grays[i + 1]);
  const T = motionThreshold(m, app.sens);
  maskCanvas.width = app.W;
  maskCanvas.height = app.H;
  const mc = maskCanvas.getContext('2d')!;
  const img = mc.createImageData(app.W, app.H);
  for (let j = 0; j < m.length; j++) {
    if (m[j] >= T) {
      img.data[j * 4] = 255;
      img.data[j * 4 + 1] = 40;
      img.data[j * 4 + 2] = 80;
      img.data[j * 4 + 3] = 200;
    }
  }
  mc.putImageData(img, 0, 0);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskCanvas, 0, 0, app.W * k, app.H * k);
  ctx.restore();
}

for (const [id, set] of [
  ['show-skel', (v: boolean) => (showSkel = v)],
  ['show-arc', (v: boolean) => (showArc = v)],
  ['show-cands', (v: boolean) => (showCands = v)],
  ['show-mask', (v: boolean) => (showMask = v)],
] as const) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    set((e.target as HTMLInputElement).checked);
    render();
  });
}

function updateMarkers() {
  const host = $('markers');
  host.innerHTML = '';
  if (!analyzed()) return;
  const n = Math.max(1, app.frames.length - 1);
  const add = (f: number, cls: string) => {
    const i = document.createElement('i');
    i.className = cls;
    i.style.left = `${(f / n) * 100}%`;
    host.append(i);
  };
  app.track.forEach((p) => add(p.frame, p.manual ? 'manual' : ''));
  const r = app.result;
  if (r && !('error' in r)) add(r.releaseFrame, 'release');
}

// ---------- tools ----------
const HINTS: Record<Tool, string> = {
  none: '',
  ball: 'Click the hammer ball in this frame (advances to the next frame). Esc to stop.',
  ground: 'Click two points on the ground (e.g. either side of the circle).',
  edge: 'Click the front edge of the throwing circle (where distance is measured from).',
  calib: '',
};
const CALIB_STEPS = [
  '1/5 · Click the HORIZON — where the flat ground meets the sky far away (or the vanishing point of straight lines on the ground).',
  '2/5 · Click the LEFT-most point of the circle.',
  '3/5 · Click the RIGHT-most point of the circle.',
  '4/5 · Click the NEAREST point of the circle (its bottom edge in the picture).',
  '5/5 · Click the FARTHEST point of the circle (its top edge in the picture).',
];
function setTool(t: Tool) {
  app.tool = t;
  app.pendingGround = null;
  app.calibClicks = [];
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  canvas.classList.toggle('picking', t !== 'none');
  const hint = $('tool-hint');
  hint.hidden = t === 'none';
  hint.textContent = t === 'calib' ? CALIB_STEPS[0] : HINTS[t];
  if (t !== 'none') pause();
  render();
}

function flashHint(text: string, ms = 6000) {
  const hint = $('tool-hint');
  hint.hidden = false;
  hint.textContent = text;
  setTimeout(() => {
    if (app.tool === 'none') hint.hidden = true;
  }, ms);
}

function finishCalibration() {
  const [horizon, left, right, near, far] = app.calibClicks;
  const g = app.setup.groundLine;
  const roll = g ? Math.atan2(g.y2 - g.y1, g.x2 - g.x1) : 0;
  try {
    const c = calibrateFromCircle({ horizon, left, right, near, far }, app.W, app.H, roll);
    Object.assign(app.setup, {
      calib: { H: c.H, C: c.C },
      pitchDeg: c.pitchDeg,
      hfovDeg: Math.round(c.hfovDeg * 10) / 10,
      cameraDistance: Math.round(c.distance * 100) / 100,
      circleEdge: null,
    });
    setTool('none');
    syncForm();
    recompute();
    flashHint(
      `Calibrated: camera ${c.distance.toFixed(1)} m from the circle, ${c.H.toFixed(2)} m high, tilted ${c.pitchDeg.toFixed(1)}° down, lens ≈${c.hfovDeg.toFixed(0)}°.` +
        (c.rmsPx > 3 ? ' The circle fit is loose — check the blue outline sits on the circle.' : ' The blue outline should sit on the circle.'),
    );
  } catch (err) {
    setTool('none');
    alert((err as Error).message);
  }
}

/** Current camera model from the setup (for drawing the calibration check). */
function setupCam(): Cam {
  const g = app.setup.groundLine;
  const roll = g ? Math.atan2(g.y2 - g.y1, g.x2 - g.x1) : 0;
  return {
    f: focalPx(app.W, app.setup.hfovDeg), cx: app.W / 2, cy: app.H / 2,
    cos: Math.cos(roll), sin: Math.sin(roll), pitch: (app.setup.pitchDeg * Math.PI) / 180,
  };
}
document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)),
);

canvas.addEventListener('click', (e) => {
  if (!app.video) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * app.W;
  const y = ((e.clientY - rect.top) / rect.height) * app.H;
  // Ground/circle/calibration clicks are scene points: store them in the reference frame.
  const co = (analyzed() && app.frames[app.cur]?.off) || { x: 0, y: 0 };
  const rx = x - co.x, ry = y - co.y;
  if (app.tool === 'ball') {
    if (!analyzed()) return alert('Analyze the video first, then mark the ball.');
    const fr = app.frames[app.cur];
    app.track = app.track.filter((p) => p.frame !== fr.frame);
    app.track.push({ frame: fr.frame, t: fr.t, x, y, manual: true });
    app.track.sort((a, b) => a.frame - b.frame);
    recompute();
    showFrame(app.cur + 1);
  } else if (app.tool === 'ground') {
    if (!app.pendingGround) {
      app.pendingGround = { x: rx, y: ry };
      render();
    } else {
      const a = app.pendingGround;
      if (Math.abs(rx - a.x) < 5) return; // need two distinct points left-right
      const [p, q] = a.x < rx ? [a, { x: rx, y: ry }] : [{ x: rx, y: ry }, a];
      app.setup.groundLine = { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
      setTool('none');
      recompute();
    }
  } else if (app.tool === 'edge') {
    app.setup.circleEdge = { x: rx, y: ry };
    setTool('none');
    recompute();
  } else if (app.tool === 'calib') {
    app.calibClicks.push({ x: rx, y: ry });
    if (app.calibClicks.length >= 5) finishCalibration();
    else {
      $('tool-hint').textContent = CALIB_STEPS[app.calibClicks.length];
      render();
    }
  }
});

function setReleaseHere() {
  if (!analyzed()) return;
  app.setup.releaseFrame = app.frames[app.cur].frame;
  recompute();
}
function deletePoint() {
  const f = app.frames[app.cur]?.frame;
  app.track = app.track.filter((p) => p.frame !== f);
  if (app.setup.releaseFrame === f) app.setup.releaseFrame = null;
  recompute();
}
$('set-release').addEventListener('click', setReleaseHere);
$('del-point').addEventListener('click', deletePoint);
$('goto-release').addEventListener('click', () => {
  const r = app.result;
  if (r && !('error' in r)) showFrame(r.bodyFrame ?? r.releaseFrame);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea') || !app.video) return;
  if (e.key === ' ' && (e.target as HTMLElement).closest('button, label')) return; // the focused button handles Space
  const cur = parseInt(scrub.value, 10);
  switch (e.key) {
    case ' ': playing ? pause() : play(); break;
    case 'ArrowLeft': pause(); showFrame(cur - 1); break;
    case 'ArrowRight': pause(); showFrame(cur + 1); break;
    case 'b': case 'B': setTool('ball'); break;
    case 'g': case 'G': setTool('ground'); break;
    case 'r': case 'R': setReleaseHere(); break;
    case 'Delete': case 'Backspace': deletePoint(); break;
    case 'Escape': setTool('none'); break;
    default: return;
  }
  e.preventDefault();
});

// ---------- frame strip ----------
let stripToken = 0;
let stripKey = '';
async function renderStrip() {
  const host = $('strip');
  const tv = app.thumbVideo;
  const r = app.result && !('error' in app.result) ? app.result : null;
  // Only rebuild (re-seek thumbnails) when the points or release frame actually changed.
  const key = JSON.stringify([app.src, app.track.map((p) => [p.frame, p.x, p.y]), r?.releaseFrame, r?.excluded, r && [Math.round(r.releaseImg.x), Math.round(r.releaseImg.y)]]);
  if (key === stripKey) return;
  stripKey = key;
  const items = app.track.map((p) => ({ frame: p.frame, x: p.x, y: p.y, manual: p.manual }));
  if (r && !items.some((i) => i.frame === r.releaseFrame)) {
    items.push({ frame: r.releaseFrame, x: r.releaseImg.x, y: r.releaseImg.y, manual: false });
    items.sort((a, b) => a.frame - b.frame);
  }
  $('strip-card').hidden = items.length === 0;
  host.innerHTML = '';
  if (!tv || !items.length) return;
  const token = ++stripToken;
  const sx = tv.videoWidth / app.W;
  const crop = app.W * 0.2; // analysis px
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'thumb' + (r?.releaseFrame === it.frame ? ' release' : '');
    div.dataset.frame = String(it.frame);
    const c = document.createElement('canvas');
    c.width = 264;
    c.height = 198;
    const cap = document.createElement('div');
    cap.className = 'cap';
    const fr = app.frames[it.frame];
    const ignored = r?.excluded.includes(it.frame);
    if (ignored) div.style.opacity = '0.55';
    cap.innerHTML = `<b>#${it.frame}${r?.releaseFrame === it.frame ? ' release' : ''}</b><span>${ignored ? 'ignored · ' : ''}${fr.t.toFixed(3)}s${it.manual ? ' ✎' : ''}</span>`;
    div.append(c, cap);
    div.addEventListener('click', () => showFrame(it.frame));
    host.append(div);

    await seekTo(tv, app.seekT[it.frame]);
    if (token !== stripToken) return;
    const cw = crop * (4 / 3), ch = crop;
    const x0 = it.x - cw / 2, y0 = it.y - ch / 2;
    const g = c.getContext('2d')!;
    g.drawImage(tv, x0 * sx, y0 * sx, cw * sx, ch * sx, 0, 0, c.width, c.height);
    const kk = c.width / cw;
    g.strokeStyle = it.manual ? COLORS.ballManual : COLORS.ball;
    g.lineWidth = 3;
    g.beginPath();
    g.arc((it.x - x0) * kk, (it.y - y0) * kk, 16, 0, Math.PI * 2);
    g.stroke();
  }
  renderStripSelection();
}

function renderStripSelection() {
  document.querySelectorAll<HTMLElement>('.thumb').forEach((t) =>
    t.classList.toggle('current', analyzed() && t.dataset.frame === String(app.cur)),
  );
}

// ---------- busy overlay ----------
function showBusy(text: string, p: number) {
  $('busy').hidden = false;
  $('busy-text').textContent = text;
  $('busy-bar').style.width = `${Math.round(p * 100)}%`;
  if ($('viewer').hidden) $('viewer').hidden = false;
}
function hideBusy() {
  $('busy').hidden = true;
}

// ---------- tutorial ----------
const dot = (c: string) => `<i class="sw" style="background:${c}"></i>`;
const TOUR: TourStep[] = [
  {
    title: 'Hammer Throw Analyzer',
    body: `<p>Give it a video of a throw. It finds the hammer after release, works out the <b>release speed, angle and height</b>, and predicts how far it goes.</p>
      <p>This tour uses a demo throw that's <b>already marked</b>, so you don't have to set anything up. Use <kbd>←</kbd> <kbd>→</kbd> or the buttons to move through it.</p>`,
  },
  {
    target: '.canvas-wrap',
    title: 'The release frame',
    body: `<p>This is the moment the hammer leaves the thrower's hands. This is a real Highland Games throw in slow motion, auto-analyzed.</p>
      <ul><li>${dot(COLORS.vel)}<b>Arrow:</b> release speed and direction</li>
      <li>${dot(COLORS.vel)}<b>Arc:</b> release angle above horizontal</li>
      <li>${dot(COLORS.ground)}<b>Green bar:</b> release height above the ground</li>
      <li>${dot(COLORS.ball)}<b>Red dots + dashed line:</b> the ball in each frame, and the 3D flight fitted through them</li></ul>`,
    enter: async () => {
      const r = app.result;
      if (r && !('error' in r)) await showFrame(r.releaseFrame);
    },
    place: 'below',
  },
  {
    target: '.transport',
    title: 'Step through the video',
    body: `<p>Drag the slider or use <kbd>←</kbd> <kbd>→</kbd> to go frame by frame. The ticks underneath mark the frames where the ball was found, and the <b style="color:var(--accent-2)">yellow</b> tick is the release.</p>`,
    place: 'below',
  },
  {
    target: '#strip-card',
    title: 'Frames used',
    body: `<p>These are the exact frames the answer is built from, each zoomed in on the ball. Click one to jump to it.</p><p>A faded frame was <b>ignored</b> because it didn't fit the arc, for example a blurry first frame where the ball still overlaps the arms.</p>`,
    place: 'above',
  },
  {
    target: '#result-card',
    title: 'The answer',
    body: `<p>The big number is the predicted distance, with its uncertainty. It's measured from the release point, or from the circle if you mark the circle edge.</p><p>Demos with a <b>known answer</b> (the synthetic ones) show it underneath, so you can judge how close the analyzer gets. This real throw has no official mark.</p>`,
    place: 'left',
  },
  {
    target: '#geo-card',
    title: 'Throw geometry (top view)',
    body: `<p>The camera is rarely exactly side-on. The analyzer works out the <b>throw angle</b> automatically, because a ball flying away from the camera bends and slows in the picture.</p><p>To override it, drag the red handle or type an angle. Also note that the ball flies about 1.6 m to the thrower's side, since it leaves its orbit on a tangent. That's why <b>handedness</b> matters.</p>`,
    place: 'left',
  },
  {
    target: '#scale-card',
    title: 'Measurement check',
    body: `<p>Sanity checks. The most useful line is <b>“If camera distance is 10% off”</b>: distance scales roughly with speed², so measuring the camera distance carefully pays off.</p>`,
    place: 'left',
  },
  {
    target: '#chart-card',
    title: 'Predicted flight',
    body: `<p>The full flight from the side, with air drag (solid) and without (dashed). Drag costs a few metres on a big throw.</p>`,
    place: 'above',
  },
  {
    target: '.tools',
    title: 'When the auto-detection gets it wrong',
    body: `<ul><li><b>Mark ball</b> <kbd>B</kbd>: click the ball, and it moves to the next frame</li>
      <li><b>Remove ball point</b> <kbd>Del</kbd>: drop a bad point</li>
      <li><b>Release = this frame</b> <kbd>R</kbd></li>
      <li><b>Ground line</b> <kbd>G</kbd>: click two points on the ground</li>
      <li><b>Circle edge</b>: measure from the circle, like the official tape</li>
      <li><b>Motion blobs</b>: shows what the detector saw</li>
      <li><b>Save markings</b>: keeps your work as a file you can load later</li></ul>`,
    place: 'below',
  },
  {
    target: '.side .card',
    title: 'Your own video',
    body: `<p>Open your video, then fill in three things:</p><ul><li><b>Camera → thrower distance</b>: measure it, it matters most</li><li><b>Lens</b>: 1×, 0.5×, …</li><li><b>Thrower</b>: right- or left-handed</li></ul><p>Then press <b>Analyze throw</b>.</p>`,
    place: 'left',
  },
  {
    title: 'Filming tips',
    body: `<ul><li>Put the phone on a <b>tripod</b> roughly side-on, level, with the whole thrower in view.</li>
      <li>Leave room on the throw side so the ball stays in frame for about half a second after release.</li>
      <li>Further away with 2× zoom beats close up with a wide lens.</li>
      <li><b>Slow-mo</b> (120/240 fps) gives far more ball positions and tighter numbers.</li></ul>
      <p>Open <b>Tutorial</b> any time to see this again.</p>`,
  },
];

async function startTour() {
  // The tour needs a marked throw on screen; open the demo if nothing is analyzed yet.
  if (!app.frames.length || !app.result || 'error' in app.result) await openDemo();
  try {
    localStorage.setItem('hammer-throw-toured', '1');
  } catch { /* ignore */ }
  runTour(TOUR);
}
$('tour').addEventListener('click', startTour);
$('tour2').addEventListener('click', startTour);

loadSetup();
syncForm();
// Test/debug hooks
Object.assign(window, { __app: app, __api: { recompute, showFrame, retrack, applySession, openDemo, startTour } });
