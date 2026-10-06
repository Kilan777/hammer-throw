// Bird's-eye view of the setup: camera, line of sight, circle, sector, and the fitted flight line.
// The flight direction handle can be dragged to set the throw angle by hand.

import { CIRCLE_RADIUS, type Result } from './analyze';

const NS = 'http://www.w3.org/2000/svg';
const SECTOR_HALF = (34.92 / 2) * (Math.PI / 180);

export interface TopViewOpts {
  hfovDeg: number;
  onDragPsi: (psiDeg: number) => void;
}

export function renderTopView(host: HTMLElement, r: Result, o: TopViewOpts) {
  host.innerHTML = '';
  const g = r.geo;
  const D = Math.hypot(g.A.x, g.A.z);
  const C = g.circleCentre ?? g.A;
  // View: camera at the bottom, thrower ~60% up, flight heading off to one side.
  const span = Math.max(14, D * 1.5);
  const top = D + span * 0.45;
  const bottom = -span * 0.12;
  const half = span / 2;
  const cxm = C.x + (g.dir * span) / 6; // shift view toward the throw side
  const W = 420, H = Math.round((W * (top - bottom)) / span);
  const sx = (x: number) => ((x - (cxm - half)) / span) * W;
  const sy = (z: number) => ((top - z) / (top - bottom)) * H;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'top-svg', role: 'img', 'aria-label': 'Top-down view of camera and throw' });

  // Camera FOV wedge
  const fov = (o.hfovDeg / 2) * (Math.PI / 180);
  const far = top * 1.2;
  svg.append(el('path', { d: `M${sx(0)},${sy(0)} L${sx(-Math.tan(fov) * far)},${sy(far)} L${sx(Math.tan(fov) * far)},${sy(far)} Z`, class: 'fov' }));

  // Sector lines from the circle centre (assumes the sector is centred on the throw direction)
  const rot = (u: { x: number; z: number }, a: number) => ({ x: u.x * Math.cos(a) - u.z * Math.sin(a), z: u.x * Math.sin(a) + u.z * Math.cos(a) });
  for (const a of [-SECTOR_HALF, SECTOR_HALF]) {
    const v = rot(g.u, a);
    svg.append(el('line', { x1: sx(C.x), y1: sy(C.z), x2: sx(C.x + v.x * span), y2: sy(C.z + v.z * span), class: 'sector' }));
  }

  // Line of sight + distance label
  svg.append(el('line', { x1: sx(0), y1: sy(0), x2: sx(g.A.x), y2: sy(g.A.z), class: 'sight' }));
  svg.append(txt(`${D.toFixed(1)} m`, sx(g.A.x / 2) + 6, sy(g.A.z / 2), 'lbl', 'start'));

  // Square-on reference through the release point
  const side = { x: g.dir * g.ell.z, z: -g.dir * g.ell.x };
  const refLen = span * 0.32;
  svg.append(el('line', { x1: sx(g.release.x), y1: sy(g.release.z), x2: sx(g.release.x + side.x * refLen), y2: sy(g.release.z + side.z * refLen), class: 'ref' }));

  // Circle + thrower axis
  svg.append(el('circle', { cx: sx(C.x), cy: sy(C.z), r: (CIRCLE_RADIUS / span) * W, class: 'ring' }));
  svg.append(el('circle', { cx: sx(g.A.x), cy: sy(g.A.z), r: 3, class: 'axis' }));

  // Flight line (fitted) with drag handle
  const fl = span * 0.38;
  const hx = g.release.x + g.u.x * fl, hz = g.release.z + g.u.z * fl;
  svg.append(el('line', { x1: sx(g.release.x), y1: sy(g.release.z), x2: sx(hx), y2: sy(hz), class: 'flight' }));
  svg.append(el('circle', { cx: sx(g.release.x), cy: sy(g.release.z), r: 4, class: 'rel' }));
  const handle = el('circle', { cx: sx(hx), cy: sy(hz), r: 9, class: 'handle' });
  const htitle = document.createElementNS(NS, 'title');
  htitle.textContent = 'Drag to set the throw direction by hand';
  handle.append(htitle);
  svg.append(handle);

  // ψ arc label
  const a0 = Math.atan2(-(side.z), side.x);
  const a1 = Math.atan2(-(g.u.z), g.u.x);
  let da = a1 - a0;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const R = 34;
  const p0 = { x: sx(g.release.x) + R * Math.cos(a0), y: sy(g.release.z) + R * Math.sin(a0) };
  const p1 = { x: sx(g.release.x) + R * Math.cos(a0 + da), y: sy(g.release.z) + R * Math.sin(a0 + da) };
  svg.append(el('path', { d: `M${p0.x},${p0.y} A${R},${R} 0 0 ${da > 0 ? 1 : 0} ${p1.x},${p1.y}`, class: 'psi-arc' }));
  const am = a0 + da / 2;
  svg.append(txt(`${Math.abs(r.psi).toFixed(0)}°`, sx(g.release.x) + (R + 14) * Math.cos(am), sy(g.release.z) + (R + 14) * Math.sin(am) + 4, 'psi', 'middle'));

  // Camera icon
  svg.append(el('rect', { x: sx(0) - 9, y: sy(0) - 6, width: 18, height: 12, rx: 2, class: 'cam' }));
  svg.append(txt('camera', sx(0), sy(0) + 20, 'lbl', 'middle'));

  host.append(svg);

  // Dragging the handle sets ψ manually. Listeners live on the host (it survives re-renders,
  // which happen on every drag step as the fit updates).
  current = {
    W, H, svg,
    toPlan: (cx, cy, rect) => {
      const b = rect ?? svg.getBoundingClientRect();
      const x = ((cx - b.left) / b.width) * W;
      const y = ((cy - b.top) / b.height) * H;
      return { x: cxm - half + (x / W) * span, z: top - (y / H) * (top - bottom) };
    },
    release: g.release,
    side,
    ell: g.ell,
    onDragPsi: o.onDragPsi,
  };
  if (!host.dataset.bound) {
    host.dataset.bound = '1';
    // Freeze the view + anchor at drag start: each step refits, which moves the release point,
    // and measuring from the moved point would feed back and run away.
    let drag: NonNullable<typeof current> | null = null;
    host.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element).classList.contains('handle') || !current) return;
      const b = current.svg.getBoundingClientRect();
      const toPlan = current.toPlan;
      drag = { ...current, toPlan: (x, y) => toPlan(x, y, b) };
      host.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    const end = () => (drag = null);
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const c = drag;
      const p = c.toPlan(e.clientX, e.clientY);
      const v = { x: p.x - c.release.x, z: p.z - c.release.z };
      const n = Math.hypot(v.x, v.z);
      if (n < 0.5) return;
      const along = (v.x * c.side.x + v.z * c.side.z) / n;
      const away = (v.x * c.ell.x + v.z * c.ell.z) / n;
      if (along <= 0.2) return; // keep it heading the way the ball actually went
      const psi = (Math.atan2(away, along) * 180) / Math.PI;
      c.onDragPsi(Math.max(-60, Math.min(60, Math.round(psi * 2) / 2)));
    });
  }
}

let current: {
  W: number;
  H: number;
  svg: SVGElement;
  toPlan: (cx: number, cy: number, rect?: DOMRect) => { x: number; z: number };
  release: { x: number; z: number };
  side: { x: number; z: number };
  ell: { x: number; z: number };
  onDragPsi: (psi: number) => void;
} | null = null;

function el(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function txt(s: string, x: number, y: number, cls: string, anchor: string) {
  const t = el('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = s;
  return t;
}
