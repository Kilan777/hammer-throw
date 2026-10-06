// Side-view flight path chart (SVG): drag vs. no-drag, with distance ticks.

import type { Result } from './analyze';

const NS = 'http://www.w3.org/2000/svg';

export function renderFlightChart(host: HTMLElement, r: Result) {
  host.innerHTML = '';
  const W = 720, H = 240;
  const m = { l: 40, r: 16, t: 16, b: 30 };
  const xMax = Math.ceil((Math.max(r.distVac, r.distDrag) + 4) / 10) * 10;
  const yMax = Math.max(5, Math.ceil((r.apex * 1.25) / 5) * 5);
  const sx = (x: number) => m.l + (x / xMax) * (W - m.l - m.r);
  const sy = (y: number) => H - m.b - (y / yMax) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'flight-svg', role: 'img', 'aria-label': 'Predicted flight path' });

  for (let x = 0; x <= xMax; x += 10) {
    svg.append(el('line', { x1: sx(x), x2: sx(x), y1: sy(0), y2: sy(yMax), class: 'grid' }));
    const last = x + 10 > xMax;
    svg.append(text(last ? `${x} m` : `${x}`, sx(x), H - m.b + 16, 'axis', last ? 'end' : 'middle'));
  }
  for (let y = 0; y <= yMax; y += 5) {
    svg.append(el('line', { x1: sx(0), x2: sx(xMax), y1: sy(y), y2: sy(y), class: 'grid' }));
    svg.append(text(`${y}`, m.l - 6, sy(y) + 4, 'axis', 'end'));
  }
  svg.append(el('line', { x1: sx(0), x2: sx(xMax), y1: sy(0), y2: sy(0), class: 'ground' }));

  // Paths start at the release point; shift by the circle-edge offset so x = 0 is the circle.
  const off = r.offset;
  const path = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x + off).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  svg.append(el('path', { d: path(r.pathVac), class: 'vac' }));
  svg.append(el('path', { d: path(r.pathDrag), class: 'drag' }));

  svg.append(el('circle', { cx: sx(off), cy: sy(r.height), r: 4, class: 'rel' }));
  for (const [d, cls, dy] of [[r.distDrag, 'drag-l', -10], [r.distVac, 'vac-l', -26]] as const) {
    svg.append(el('circle', { cx: sx(d), cy: sy(0), r: 4, class: cls }));
    svg.append(text(`${d.toFixed(1)} m`, sx(d), sy(0) + dy, cls, 'middle'));
  }
  host.append(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `<span><i class="sw drag"></i>With air drag</span><span><i class="sw vac"></i>No drag (vacuum)</span>`;
  host.append(legend);
}

function el(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function text(s: string, x: number, y: number, cls: string, anchor: string) {
  const t = el('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = s;
  return t;
}
