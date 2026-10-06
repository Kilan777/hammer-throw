// Copies MediaPipe wasm into public/ and downloads the pose model so the app runs offline.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('copied mediapipe wasm');
}

const models = {
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
};
mkdirSync(join(root, 'public/models'), { recursive: true });
for (const [name, url] of Object.entries(models)) {
  const dst = join(root, 'public/models', name);
  if (existsSync(dst)) continue;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
    console.log('downloaded', name);
  } catch (e) {
    console.warn(`could not download ${name} (${e.message}); the app will fetch it from the CDN at runtime`);
  }
}
