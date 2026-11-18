// Downloads the MRX separation model (MIT, MERL; ONNX int8 export by audiojs) into models/,
// checking its SHA-256. The model is not kept in git (31 MB).
import { createHash } from 'node:crypto';
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
