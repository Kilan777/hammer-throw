// Minimal guided tour: dims the page, spotlights one element per step and shows a card next to it.

export interface TourStep {
  target?: string; // CSS selector; omitted → centred card
  title: string;
  body: string; // HTML
  /** Runs when the step is shown (e.g. jump to a frame, toggle an overlay). */
  enter?: () => void | Promise<void>;
  /** Prefer the card on this side of the target. */
  place?: 'right' | 'left' | 'below' | 'above';
}

export function runTour(steps: TourStep[], onClose?: () => void) {
  document.querySelector('.tour-root')?.remove();
  const root = document.createElement('div');
  root.className = 'tour-root';
  root.innerHTML = `
    <div class="tour-shade"></div>
    <div class="tour-spot" hidden></div>
    <div class="tour-card" role="dialog" aria-live="polite">
      <div class="tour-step"></div>
      <h3></h3>
      <div class="tour-body"></div>
      <div class="tour-nav">
        <button class="btn ghost small" data-act="skip">Skip tour</button>
        <span class="spacer"></span>
        <button class="btn ghost small" data-act="back">Back</button>
        <button class="btn primary small" data-act="next">Next</button>
      </div>
    </div>`;
  document.body.append(root);
  const spot = root.querySelector<HTMLElement>('.tour-spot')!;
  const card = root.querySelector<HTMLElement>('.tour-card')!;
  const shade = root.querySelector<HTMLElement>('.tour-shade')!;
  let i = 0;
  let target: HTMLElement | null = null;

  const place = () => {
    const step = steps[i];
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = Math.min(380, vw - 24);
    card.style.width = `${cw}px`;
    if (!target) {
      spot.hidden = true;
      shade.hidden = false;
      card.style.left = `${(vw - cw) / 2}px`;
      card.style.top = `${Math.max(12, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    shade.hidden = true; // the spotlight's huge shadow does the dimming
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.hidden = false;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const ch = card.offsetHeight;
    const fits = {
      right: r.right + 16 + cw < vw,
      left: r.left - 16 - cw > 0,
      below: r.bottom + 16 + ch < vh,
      above: r.top - 16 - ch > 0,
    };
    const order = [step.place, 'right', 'left', 'below', 'above'].filter(Boolean) as (keyof typeof fits)[];
    const side = order.find((s) => fits[s]);
    let x: number, y: number;
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? r.right + 16 : r.left - 16 - cw;
      y = Math.min(Math.max(12, r.top), vh - ch - 12);
    } else if (side === 'below' || side === 'above') {
      x = Math.min(Math.max(12, r.left), vw - cw - 12);
      y = side === 'below' ? r.bottom + 16 : r.top - 16 - ch;
    } else {
      // Target fills the screen: float the card in the lower corner.
      x = vw - cw - 16;
      y = vh - ch - 16;
    }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };

  const show = async (n: number) => {
    i = Math.max(0, Math.min(steps.length - 1, n));
    const step = steps[i];
    await step.enter?.();
    target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    if (target && (target.hidden || target.offsetParent === null)) target = null;
    root.querySelector('.tour-step')!.textContent = `${i + 1} / ${steps.length}`;
    root.querySelector('h3')!.textContent = step.title;
    root.querySelector('.tour-body')!.innerHTML = step.body;
    root.querySelector<HTMLButtonElement>('[data-act="back"]')!.disabled = i === 0;
    root.querySelector<HTMLButtonElement>('[data-act="next"]')!.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    place();
    root.querySelector<HTMLButtonElement>('[data-act="next"]')!.focus();
  };

  const close = () => {
    root.remove();
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') i === steps.length - 1 ? close() : show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'skip') close();
    else if (act === 'back') show(i - 1);
    else if (act === 'next') (i === steps.length - 1 ? close() : show(i + 1));
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('keydown', onKey, true);
  show(0);
  return { close };
}
