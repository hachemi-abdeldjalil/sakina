// Builds the unpacked extension into build/ (load that folder in chrome://extensions).
// `node scripts/build.mjs --zip` also writes Sakina-<version>.zip for the Web Store.
import * as esbuild from 'esbuild';
import { cpSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

const common = {
  bundle: true,
  minify: true,
  target: 'chrome116',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await Promise.all([
  esbuild.build({ ...common, entryPoints: [join(root, 'src/content/main.js')], format: 'iife', outfile: join(out, 'dist/content.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/audio/processor.js')], format: 'iife', outfile: join(out, 'dist/worklet.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/popup/popup.js')], format: 'iife', outfile: join(out, 'dist/popup.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/capture/main-world.js')], format: 'iife', outfile: join(out, 'dist/capture.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/engine/frame.js')], format: 'iife', outfile: join(out, 'dist/engine-frame.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/engine/worker.js')], format: 'esm', outfile: join(out, 'dist/engine-worker.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/engine/offscreen.js')], format: 'iife', outfile: join(out, 'dist/offscreen.js') }),
  esbuild.build({ ...common, entryPoints: [join(root, 'src/background/sw.js')], format: 'iife', outfile: join(out, 'dist/background.js') }),
]);

cpSync(join(root, 'static'), out, { recursive: true });
cpSync(join(root, 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm'), join(out, 'dist/rnnoise.wasm'));
// ONNX Runtime Web (WebAssembly build) for the v2 separation worker
mkdirSync(join(out, 'dist/ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  cpSync(join(root, 'node_modules/onnxruntime-web/dist', f), join(out, 'dist/ort', f));
}
// The models (not in git): `npm run fetch-model` downloads and checks them.
mkdirSync(join(out, 'models'), { recursive: true });
for (const f of ['mrx.int8.onnx', 'mdx-vocals.fp16w.onnx']) {
  const model = join(root, 'models', f);
  try { statSync(model); } catch { console.error(`models/${f} is missing: run \`npm run fetch-model\` first`); process.exit(1); }
  cpSync(model, join(out, 'models', f));
}

// Licences of everything the package ships: Sakina's own, plus the third-party code and models.
const lic = (f) => readFileSync(join(root, f), 'utf8').trim();
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), [
  'Sakina includes the following third-party software and models.',
  '',
  '- MRX source-separation model (models/mrx.int8.onnx): MIT licence. https://huggingface.co/audiojs/mrx',
  '- UVR-MDX-NET 1_9703 vocals model (models/mdx-vocals.fp16w.onnx, weights stored as float16): trained and',
  '  published by the Ultimate Vocal Remover team (Anjok07, aufr33), credited here as UVR asks.',
  '  https://github.com/Anjok07/ultimatevocalremovergui  https://github.com/TRvlvr/model_repo',
  '- ONNX Runtime Web (dist/ort/, dist/engine-worker.js): MIT licence, Copyright (c) Microsoft Corporation.',
  '  https://github.com/microsoft/onnxruntime/blob/main/LICENSE',
  '- RNNoise (dist/rnnoise.wasm): BSD-3-Clause, Xiph.Org Foundation and contributors.',
  '  https://github.com/xiph/rnnoise (COPYING)',
  '- @jitsi/rnnoise-wasm (WebAssembly build of RNNoise): Apache License 2.0, text below.',
  '',
  '==== Sakina ====', lic('LICENSE'), '',
  '==== Apache License 2.0 (@jitsi/rnnoise-wasm) ====', lic('node_modules/@jitsi/rnnoise-wasm/LICENSE'), '',
].join('\n'));

const size = (f) => (statSync(join(out, f)).size / 1024 / 1024).toFixed(2) + ' MB';
console.log(`built ${out}`);
for (const f of ['dist/content.js', 'dist/capture.js', 'dist/worklet.js', 'dist/rnnoise.wasm', 'dist/engine-worker.js', 'dist/ort/ort-wasm-simd-threaded.wasm', 'models/mrx.int8.onnx', 'models/mdx-vocals.fp16w.onnx', 'dist/popup.js']) console.log(`  ${f}  ${size(f)}`);

if (process.argv.includes('--zip')) {
  const { version } = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const zip = join(root, `Sakina-${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.', '-x', '.DS_Store'], { cwd: out });
  console.log(`  zip: ${zip}`);
}
