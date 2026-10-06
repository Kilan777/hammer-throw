// Projectile model for the hammer after release, with optional quadratic air drag.

export const G = 9.81;

export interface HammerSpec {
  label: string;
  mass: number; // kg
  diameter: number; // m, ball diameter (typical, rules allow a range)
}

export const HAMMERS: HammerSpec[] = [
  { label: "Men's senior — 7.26 kg", mass: 7.26, diameter: 0.12 },
  { label: 'Men U20 — 6 kg', mass: 6.0, diameter: 0.115 },
  { label: 'Men U18 — 5 kg', mass: 5.0, diameter: 0.11 },
  { label: "Women's senior — 4 kg", mass: 4.0, diameter: 0.1 },
  { label: 'Women U18 — 3 kg', mass: 3.0, diameter: 0.095 },
  // Highland Games (ball on a cane handle, thrown standing). Appended so saved indices stay valid.
  { label: 'Scottish light hammer — 16 lb', mass: 7.26, diameter: 0.12 },
  { label: 'Scottish heavy hammer — 22 lb', mass: 9.98, diameter: 0.13 },
];

export interface DragParams {
  mass: number;
  diameter: number;
  cd: number; // effective drag coefficient (ball + wire + handle)
  rho: number; // air density kg/m^3
}

export interface Flight {
  range: number; // horizontal distance from release point to landing (m)
  flightTime: number;
  apex: number; // max height (m)
  points: { x: number; y: number }[]; // sampled path
}

export function simulate(
  speed: number,
  angleDeg: number,
  height: number,
  drag: DragParams | null,
): Flight {
  const a = (angleDeg * Math.PI) / 180;
  if (!drag) {
    const vx = speed * Math.cos(a);
    const vy = speed * Math.sin(a);
    const tf = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * G * height))) / G;
    const points = [];
    const n = 120;
    for (let i = 0; i <= n; i++) {
      const t = (tf * i) / n;
      points.push({ x: vx * t, y: height + vy * t - 0.5 * G * t * t });
    }
    return { range: vx * tf, flightTime: tf, apex: height + Math.max(0, (vy * vy) / (2 * G)), points };
  }

  const area = Math.PI * (drag.diameter / 2) ** 2;
  const k = (0.5 * drag.rho * drag.cd * area) / drag.mass;
  // State: x, y, vx, vy. RK4 with a fixed small step.
  const deriv = (s: number[]) => {
    const v = Math.hypot(s[2], s[3]);
    return [s[2], s[3], -k * v * s[2], -G - k * v * s[3]];
  };
  let s = [0, height, speed * Math.cos(a), speed * Math.sin(a)];
  const dt = 0.002;
  let t = 0;
  let apex = height;
  const points = [{ x: 0, y: height }];
  for (let step = 0; step < 20000; step++) {
    const k1 = deriv(s);
    const k2 = deriv(s.map((v, i) => v + (dt / 2) * k1[i]));
    const k3 = deriv(s.map((v, i) => v + (dt / 2) * k2[i]));
    const k4 = deriv(s.map((v, i) => v + dt * k3[i]));
    const next = s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    if (next[1] < 0) {
      // Interpolate the ground crossing.
      const f = s[1] / (s[1] - next[1]);
      const x = s[0] + f * (next[0] - s[0]);
      points.push({ x, y: 0 });
      return { range: x, flightTime: t + f * dt, apex, points };
    }
    s = next;
    t += dt;
    apex = Math.max(apex, s[1]);
    if (step % 10 === 0) points.push({ x: s[0], y: s[1] });
  }
  return { range: s[0], flightTime: t, apex, points };
}

/** Launch angle that maximises range for a given speed and height (vacuum, closed form). */
export function optimalAngleVacuum(speed: number, height: number): number {
  const v2 = speed * speed;
  return (Math.atan(speed / Math.sqrt(v2 + 2 * G * height)) * 180) / Math.PI;
}
