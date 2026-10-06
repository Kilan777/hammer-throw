// Builds the app and publishes dist/ to the gh-pages branch of `origin` (GitHub Pages).
//   npm run deploy
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const origin = execSync('git remote get-url origin').toString().trim();

sh('npm run build');
// The app only loads the SIMD / non-SIMD wasm builds; drop the unused module variant (~12 MB).
const wasm = join('dist', 'mediapipe', 'wasm');
for (const f of readdirSync(wasm)) if (f.startsWith('vision_wasm_module_internal')) rmSync(join(wasm, f));
writeFileSync(join('dist', '.nojekyll'), '');

const git = (cmd) => sh(`git ${cmd}`, { cwd: 'dist' });
git('init -q -b gh-pages');
git('add -A');
git('-c user.name="Kilan" -c user.email="192490149+Kilan777@users.noreply.github.com" commit -q -m "Deploy"');
git(`push -f ${origin} gh-pages`);
rmSync(join('dist', '.git'), { recursive: true, force: true });
console.log('Deployed to gh-pages.');
