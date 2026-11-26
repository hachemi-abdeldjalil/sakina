// Downloads the models into models/, checking their SHA-256 (they are not kept in git):
//   - MRX separation model (MIT, MERL; ONNX int8 export by audiojs), 31 MB
//   - UVR-MDX-NET 1_9703 vocals model (Ultimate Vocal Remover team), 30 MB, the voice guard. It ships with
//     its weights stored as float16 (15 MB): scripts/mdx-fp16.py makes models/mdx-vocals.fp16w.onnx.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [
  {
    file: 'mrx.int8.onnx',
    url: 'https://huggingface.co/audiojs/mrx/resolve/main/mrx.int8.onnx',
    sha256: 'd876c92d224f5d8cd2207d528b23369da895a6de71fb24132416fcb16f9f8424',
  },
  {
    file: 'UVR_MDXNET_1_9703.onnx',
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_1_9703.onnx',
    sha256: '229ad3bb96a037e89d8ed86732d6d3675856e6a07c3e3f02896eac01ec7ee4be',
  },
];

mkdirSync(join(root, 'models'), { recursive: true });
for (const m of MODELS) {
  const path = join(root, 'models', m.file);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (existsSync(path) && sha(readFileSync(path)) === m.sha256) { console.log(`ok   ${m.file}`); continue; }
  console.log(`get  ${m.url}`);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== m.sha256) throw new Error(`${m.file}: checksum mismatch`);
  writeFileSync(path, buf);
  console.log(`saved ${m.file} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

const fp16 = join(root, 'models/mdx-vocals.fp16w.onnx');
if (existsSync(fp16)) {
  console.log('ok   mdx-vocals.fp16w.onnx');
} else {
  try {
    execFileSync(process.env.PYTHON || 'python3', [join(root, 'scripts/mdx-fp16.py'), join(root, 'models/UVR_MDXNET_1_9703.onnx'), fp16], { stdio: 'inherit' });
  } catch {
    console.error('Could not make models/mdx-vocals.fp16w.onnx: it needs Python 3 with `pip install onnx numpy`'
      + ' (or set PYTHON to such an interpreter), then run `npm run fetch-model` again.');
    process.exit(1);
  }
}
