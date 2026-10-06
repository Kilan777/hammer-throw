"""Renders a synthetic hammer throw through a pinhole camera, with a known release, for testing.

The world is the camera frame: X right, Y down, Z forward; camera level at the origin.
The thrower turns counter-clockwise (right-handed) about an axis `CAM_DIST` metres away, so the
ball leaves tangentially from an orbit of radius `R` — its flight line sits R to the thrower's
right — and the throw can be angled `psi` degrees away from (or toward) the camera.

    python3 test/make_synthetic.py --name throw  --psi 20     # demo: angled throw
    python3 test/make_synthetic.py --name square --psi 0      # square-on

Writes public/demo/<name>.webm + <name>.json (camera setup + ground truth).
Needs Pillow and an ffmpeg with libvpx (Playwright's bundled ffmpeg works).
"""
import argparse
import io
import json
import math
import os
import random
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = 1280, 720
FPS = 30
DUR = 3.0
HFOV = 65.0
F = (W / 2) / math.tan(math.radians(HFOV / 2))
CX, CY = W / 2, H / 2
GROUND_Y = 620  # image row of the ground at the thrower's feet
AXIS_PX = 430  # image column of the thrower
EXPOSURE = 1 / 120

REL_T = 1.62
SPEED, ANGLE, HEIGHT = 26.0, 40.0, 1.65
MASS, DIAM, CD, RHO = 7.26, 0.12, 0.6, 1.2
G = 9.81
OMEGA = 13.0


def unit(x, z):
    n = math.hypot(x, z)
    return x / n, z / n


class Scene:
    def __init__(self, dist, psi_deg, hand, radius):
        self.dist = dist
        ell = unit((AXIS_PX - CX) / F, 1.0)
        self.ell = ell
        self.A = (dist * ell[0], dist * ell[1])
        self.cam_h = (GROUND_Y - CY) * self.A[1] / F  # camera height above ground
        side = (ell[1], -ell[0])  # square-on, ball moving to +x in the image
        p = math.radians(psi_deg)
        self.u = unit(math.cos(p) * side[0] + math.sin(p) * ell[0], math.cos(p) * side[1] + math.sin(p) * ell[1])
        right = (self.u[1], -self.u[0])
        self.hand = 1 if hand == 'right' else -1
        self.R = radius
        self.rel = (self.A[0] + self.hand * radius * right[0], self.A[1] + self.hand * radius * right[1])
        self.phi_r = math.atan2(self.rel[1] - self.A[1], self.rel[0] - self.A[0])

    def project(self, X, Y, Z):
        return CX + F * X / Z, CY + F * Y / Z

    def world(self, plan, h):
        """Plan point (X, Z) at height h above ground → camera coords."""
        return plan[0], self.cam_h - h, plan[1]

    def ball(self, t):
        """Ball (X, Y, Z) and whether released; plus velocity direction after release."""
        if t < REL_T:
            # Counter-clockwise (seen from above) for a right-hander; clockwise for a left-hander.
            phi = self.phi_r - self.hand * OMEGA * (REL_T - t)
            plan = (self.A[0] + self.R * math.cos(phi), self.A[1] + self.R * math.sin(phi))
            h = 1.6 + 1.0 * math.sin(self.hand * (phi - self.phi_r) + 0.05)
            return self.world(plan, h), False, None
        s = drag_state(t - REL_T)
        plan = (self.rel[0] + self.u[0] * s[0], self.rel[1] + self.u[1] * s[0])
        vdir = (self.u[0] * s[2], -s[3], self.u[1] * s[2])
        return self.world(plan, s[1]), True, vdir


def rk4_drag(s, dt):
    k = 0.5 * RHO * CD * math.pi * (DIAM / 2) ** 2 / MASS

    def d(s):
        v = math.hypot(s[2], s[3])
        return [s[2], s[3], -k * v * s[2], -G - k * v * s[3]]

    k1 = d(s)
    k2 = d([s[i] + dt / 2 * k1[i] for i in range(4)])
    k3 = d([s[i] + dt / 2 * k2[i] for i in range(4)])
    k4 = d([s[i] + dt * k3[i] for i in range(4)])
    return [s[i] + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) for i in range(4)]


def drag_state(t):
    """(s along throw, height, vs, vh) after release, with drag."""
    a = math.radians(ANGLE)
    s = [0.0, HEIGHT, SPEED * math.cos(a), SPEED * math.sin(a)]
    dt = 0.0005
    for _ in range(int(round(t / dt))):
        s = rk4_drag(s, dt)
    return s


def flight_range(drag):
    a = math.radians(ANGLE)
    vx, vy = SPEED * math.cos(a), SPEED * math.sin(a)
    if not drag:
        return vx * (vy + math.sqrt(vy * vy + 2 * G * HEIGHT)) / G
    s = [0.0, HEIGHT, vx, vy]
    while True:
        n = rk4_drag(s, 0.0005)
        if n[1] < 0:
            f = s[1] / (s[1] - n[1])
            return s[0] + f * (n[0] - s[0])
        s = n


def background():
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        c = (int(150 + 60 * y / GROUND_Y), int(185 + 45 * y / GROUND_Y), 235) if y < GROUND_Y else (70, 120, 60)
        for x in range(W):
            px[x, y] = c
    d = ImageDraw.Draw(img)
    rnd = random.Random(3)
    for x in range(0, W, 18):
        h = rnd.randint(40, 90)
        d.ellipse([x - 20, GROUND_Y - 120 - h, x + 30, GROUND_Y - 60], fill=(40, 80 + rnd.randint(0, 25), 45))
    d.rectangle([0, GROUND_Y - 80, W, GROUND_Y], fill=(45, 90, 50))
    d.rectangle([AXIS_PX - 107, GROUND_Y - 2, AXIS_PX + 107, GROUND_Y + 3], fill=(180, 180, 180))
    for x in (AXIS_PX - 320, AXIS_PX + 260):
        d.rectangle([x, GROUND_Y - 600, x + 8, GROUND_Y], fill=(90, 90, 95))
    for x in range(AXIS_PX - 320, AXIS_PX + 268, 26):
        d.line([x, GROUND_Y - 600, x, GROUND_Y], fill=(110, 110, 115), width=1)
    for y in range(GROUND_Y - 600, GROUND_Y, 26):
        d.line([AXIS_PX - 320, y, AXIS_PX + 268, y], fill=(110, 110, 115), width=1)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def draw_athlete(d, sc, t, hand_px):
    ppm = F / sc.A[1]
    turn = math.sin(OMEGA * t)
    hip = (AXIS_PX, GROUND_Y - 0.95 * ppm)
    sh = (AXIS_PX - 0.1 * ppm * turn, GROUND_Y - 1.45 * ppm)
    body = (40, 40, 70)
    d.line([hip, sh], fill=body, width=int(14 + 10 * abs(turn)))
    d.ellipse([sh[0] - 13, sh[1] - 40, sh[0] + 13, sh[1] - 12], fill=(200, 160, 130))
    for side in (-1, 1):
        d.line([hip, (AXIS_PX + side * 0.15 * ppm + 6, GROUND_Y - 0.5 * ppm), (AXIS_PX + side * 0.22 * ppm, GROUND_Y)], fill=body, width=11)
    d.line([sh, hand_px], fill=(200, 160, 130), width=8)
    return sh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', default='throw')
    ap.add_argument('--psi', type=float, default=20.0, help='throw angle, + = away from camera')
    ap.add_argument('--hand', default='right', choices=['right', 'left'])
    ap.add_argument('--radius', type=float, default=1.6)
    ap.add_argument('--dist', type=float, default=10.0)
    a = ap.parse_args()
    sc = Scene(a.dist, a.psi, a.hand, a.radius)

    out_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'demo')
    os.makedirs(out_dir, exist_ok=True)
    ffmpeg = os.environ.get('FFMPEG') or os.path.expanduser('~/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux')
    path = os.path.join(out_dir, f'{a.name}.webm')
    mjpeg = os.path.join(out_dir, f'_{a.name}.mjpeg')  # some ffmpeg builds lack the pipe protocol
    stream = open(mjpeg, 'wb')
    bg = background()
    for i in range(int(DUR * FPS)):
        t = i / FPS
        img = bg.copy()
        d = ImageDraw.Draw(img, 'RGBA')
        P, released, vdir = sc.ball(t)
        bx, by = sc.project(*P)
        ppm = F / sc.A[1]
        sh = (AXIS_PX, GROUND_Y - 1.45 * ppm)
        if not released:
            L = math.hypot(bx - sh[0], by - sh[1]) or 1
            hand_px = (sh[0] + (bx - sh[0]) / L * 0.6 * ppm, sh[1] + (by - sh[1]) / L * 0.6 * ppm)
        else:
            hand_px = (sh[0] + 0.5 * ppm, sh[1] - 0.3 * ppm)
        draw_athlete(d, sc, t, hand_px)
        subs = 7
        for s in range(subs):
            Ps, _, _ = sc.ball(t + EXPOSURE * (s / (subs - 1) - 0.5))
            px, py = sc.project(*Ps)
            r = DIAM / 2 * F / Ps[2]
            d.ellipse([px - r, py - r, px + r, py + r], fill=(55, 55, 60, int(255 * 2.2 / subs)))
        if not released:
            d.line([hand_px, (bx, by)], fill=(60, 60, 60, 200), width=1)
        else:
            n = math.sqrt(sum(v * v for v in vdir))
            T = [P[k] - vdir[k] / n * 1.2 for k in range(3)]
            tx, ty = sc.project(*T)
            d.line([(bx, by), (tx, ty)], fill=(60, 60, 60, 170), width=1)  # ~8 mm at 8 m: a real wire is 3 mm
            d.rectangle([tx - 5, ty - 3, tx + 5, ty + 3], fill=(30, 30, 30, 200))
        img = Image.blend(img, Image.effect_noise((W, H), 6).convert('RGB'), 0.04)
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=92)
        stream.write(buf.getvalue())
    stream.close()
    subprocess.run(
        [ffmpeg, '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', str(FPS), '-i', mjpeg,
         '-c:v', 'libvpx', '-b:v', '6M', '-crf', '8', '-g', '15', path],
        check=True,
    )
    os.remove(mjpeg)

    info = {
        'setup': {'cameraDistance': a.dist, 'hfovDeg': HFOV, 'hand': a.hand, 'releaseRadius': a.radius},
        'truth': {
            'speed': SPEED, 'angle': ANGLE, 'height': HEIGHT, 'psi': a.psi, 'lateral': sc.hand * a.radius,
            'releaseT': REL_T, 'rangeDrag': flight_range(True), 'rangeVac': flight_range(False),
            'camHeight': sc.cam_h, 'cd': CD, 'mass': MASS, 'fps': FPS, 'groundY': GROUND_Y,
            'releaseDepth': math.hypot(*sc.rel),
        },
    }
    with open(os.path.join(out_dir, f'{a.name}.json'), 'w') as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info['truth']))


if __name__ == '__main__':
    sys.exit(main())
