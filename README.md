# Hammer Throw Analyzer

**Live: https://kilan777.github.io/hammer-throw/** — open **Tutorial** or **Demos ▾** to try it with no setup.

Give it a side-on video of a hammer throw. It finds the ball after release, works out release **speed, angle and height**, and predicts the **distance** with and without air drag. It shows every frame it used, the fitted arc, the skeleton and joint angles at release, and how confident it is.

Everything runs in the browser. Nothing is uploaded.

```bash
npm install        # also copies MediaPipe wasm + downloads the pose model into public/
npm run dev        # http://localhost:5173
```

- **Tutorial** walks you through the app on a pre-marked demo throw, so no setup is needed.
- **Demos ▾** includes a **real throw**: Milwaukee Highland Games 2014, in slow motion, with the camera tilting up to follow the ball. The app auto-tracks it, compensates the camera motion and uses the thrower's height for scale. The video is “Hammer Throw, slow motion” by Michaela Pereckas, [CC BY 3.0](https://www.youtube.com/watch?v=I_QGia0lsKA).
- **Demos ▾** opens a pre-marked throw instantly: ball points, ground line, settings and cached analysis are all included, plus the known answer for comparison.
- **▶ Play** plays the video with the overlays following along: slow-mo by default, Space to toggle, and tick **Full video** to play the whole clip.
- **Video speed** handles slow-motion clips: 2×, 4× (120 fps), 8× (240 fps), or a custom %. With enough flight points, gravity checks the setting and suggests a correction.
- **Scale from: Thrower's height**: the pose model measures the thrower in pixels, so no tape measure is needed (about ±5% from height uncertainty).
- **Camera movement** (hand-held, or following the ball) is detected and compensated automatically by background block matching. Fits and tracking happen in a stabilized frame.
- **Calibrate** (tool row) uses the throwing circle as a 2.135 m calibration target. Click the horizon, then the circle's left, right, nearest and farthest points. It solves camera distance, height, tilt and lens angle, and measures distance from the circle automatically. A blue outline shows the fitted circle so you can check it.
- **Save markings / Load markings** stores everything for a throw (settings, ball points, cached pose + motion analysis) in a `.json` file, so you can reopen it later without re-analyzing.

## Filming

- **Tripod, roughly side-on.** It doesn't have to be exactly square: the app works out the throw angle from the arc. The motion detector needs a still camera.
- **Measure the camera → circle distance** and enter it, plus the lens (1×, 0.5×, …) and whether the thrower is right- or left-handed. Scale is the number that matters most, because range goes as speed².
- **Further away is better.** The flight line sits about one release radius (~1.6 m) to the thrower's side, and its exact position is the biggest remaining uncertainty. From 20 m that's half the relative error it is from 10 m (zoom 2× to keep the ball big).
- **Keep the first ~0.5 s of flight in frame.** Leave space on the throw side so the ball stays in view for 6+ frames after release.
- **Higher fps helps a lot.** At 30 fps you get about 8–10 ball positions, which is enough for speed and angle (±1–2%) but not for the gravity self-check. 120/240 fps slow-mo gives far more points and less blur.
- Keep the camera level if you can. Otherwise, with the throwing circle in view, use **Calibrate** and the app corrects for tilt and roll.

## How it works

1. **Frames:** seeks through the clip frame by frame, recording each frame's real timestamp (phones record at variable frame rates).
2. **Pose:** MediaPipe Pose (full model) runs on a square, letterboxed copy of each frame, because MediaPipe mis-projects non-square input. Detections that aren't an upright human are thrown out. The feet give the ground line, the hips give the thrower's position, and the body box masks out the athlete's own motion.
3. **Ball candidates:** three-frame differencing (`|f−f₋₁|` AND `|f−f₊₁|`), thresholding, and connected components. Each blob is located at its densest ball-sized spot, not its centroid, so the trailing wire and handle don't drag it.
4. **Track:** RANSAC over arcs. It seeds with a straight-x arc and grows with a curved one, since perspective bends x when the throw is angled. Physical checks apply: rising at 5–75°, at least 11 m/s, steady progress every frame, moving away from the thrower. Leading orbit points are trimmed.
5. **3D fit** (`src/fit3d.ts`): Levenberg–Marquardt solves for the ball's full 3D release position and velocity through a pinhole camera, with gravity fixed. Roll comes from the ground line and camera height from the ground line plus distance.
   - **Throw angle:** comes straight out of the fitted velocity. A ball heading away from the camera slows and bends in the image, which is measurable even at 30 fps. It's auto by default, with a soft 0° ± 20° prior. You can set it by typing or by dragging the handle in the top view.
   - **Depth:** the ball leaves its orbit on a tangent, so the flight line passes one release radius to the thrower's right (right-hander) or left. That's the depth prior (±0.5 m, plus the camera-distance accuracy). Gravity alone gives an independent depth check; it's loose at 30 fps but tight with slow-mo.
   - **Outliers:** rejected against the 3D arc, since gravity is fixed and the arc can't bend to absorb them.
   - **Release:** with pose, release is where the flight line passes closest to the thrower's axis (the tangent point), and earlier points are dropped as still on the orbit. Without pose, it's half a frame before the ball is first seen free.
6. **Flight:** RK4 integration with quadratic drag (Cd ≈ 0.6 for ball + wire + handle, editable). Uncertainty comes from Monte-Carlo sampling of the 3D fit covariance, so it includes the throw-angle and flight-line-position uncertainty.

Distance is measured **from the release point** by default. Click **Circle edge** where the front of the circle meets the ground to measure the official way, from the circle along the line to its centre.

## Fixing things by hand

| Problem | Fix |
|---|---|
| Wrong/no ball track | **Mark ball** (B), then click the ball in 4+ frames after release (it auto-advances) |
| One bad point | Go to that frame, **Remove ball point** (Del) |
| Release frame wrong | Go to the release frame, **Release = this frame** (R) |
| Ground wrong / camera tilted | **Ground line** (G), then click two points on the ground |
| Throw angle looks wrong | Throw geometry → type an angle, or drag the red handle in the top view; **Auto from arc** to go back |
| Too many/few blobs | Advanced → Motion sensitivity, and turn on **Motion blobs** / **Motion mask** to see what it sees |

## Testing

```bash
python3 test/make_synthetic.py --name throw  --psi 20   # angled throw (the demo)
python3 test/make_synthetic.py --name square --psi 0    # square-on
npm run dev -- --port 5199 &
DEMO=throw node test/e2e.mjs     # headless Chrome: analyze, compare with truth, mirror/gravity/manual checks

# Fast loop for tracker/fit work: dump candidates once, then iterate in ~50 ms
DEMO=throw OUT=cands-throw.json node test/dump_cands.mjs
FAKE_POSE=1 node test/harness.mjs cands-throw.json throw
```

The synthetic scenes are rendered through a pinhole camera: a right-handed thrower orbits and releases tangentially, with the flight line 1.6 m to their side, at 26.0 m/s and 40° from 1.65 m. The camera films at 30 fps with blur, noise and a cage. MediaPipe can't find the cartoon thrower, so the tests emulate a detected hip position.

| scene | throw angle | speed | angle | height | distance (true 67.85 m) |
|---|---|---|---|---|---|
| angled 20° | 19.6° | 25.7 | 40.2° | 1.69 | 66.3 m (±9.6) |
| square-on 0° | 1.0° | 26.4 | 39.8° | 1.81 | 69.8 m (±9.9) |

At 30 fps the ± is dominated by where exactly the flight line sits (release radius). Slow-mo footage or a longer camera distance tightens it.

## Adding a demo (e.g. a real throw)

1. Put the clip in `public/demo/<id>.webm` (or `.mp4`). Trim it to the throw, about 1 s before release to 1 s after.
2. Open it in the app, set it up, press **Analyze throw**, and fix anything by hand until the result looks right.
3. Click **Save markings**, then save the file as `public/demo/<id>.session.json`. To show a known answer, add `"reference": {"distance": 80.05, "label": "official mark"}`.
4. Add an entry to `public/demo/index.json` with `"kind": "real"`. It then shows up in **Demos ▾** and opens instantly.

`node test/make_real_demo.mjs` rebuilds the real demo's session. `node test/screen.mjs <clips…>` screens videos for a visible ballistic flight (the tracker run over sliding windows), which is how the real demo was found. `node test/make_sessions.mjs` rebuilds the synthetic demos' sessions. `node test/tour.mjs` smoke-tests the demo menu and the tutorial.

## Next

- AprilTag scale: an alternative to circle calibration when the circle isn't visible.
- Release from the orbit: most real footage loses the ball within 0–3 frames of release, because it's framed tight on the athlete. Estimating release velocity from the last turn would let the app work on that kind of footage.
- Optional WebCodecs decoding for faster, exact frame access on long clips.

## Deploying

```bash
npm run deploy   # builds and force-pushes dist/ to the gh-pages branch (GitHub Pages)
BASE=https://kilan777.github.io/hammer-throw/ node test/site.mjs   # smoke-test the live site
```

## Credits

- Real demo video: [“Hammer Throw, slow motion”](https://www.youtube.com/watch?v=I_QGia0lsKA) by Michaela Pereckas (Milwaukee Highland Games 2014), licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- Pose detection: [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) (Apache 2.0).
- The synthetic demo videos are rendered by `test/make_synthetic.py`.
