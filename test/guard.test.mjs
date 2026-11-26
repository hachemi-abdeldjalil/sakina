// The voice guard (vocals model, src/sep/mdx.js) and the separation job that uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { vocalsStereo, MDX_SR, MDX_TWO_RUNS } from '../src/sep/mdx.js';
import { resample } from '../src/sep/resample.js';
import { SR, chords } from './signals.mjs';

const E = (a, from = SR, to = a.length - SR) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return e; };
const db = (r) => 10 * Math.log10(r);

test('vocals model I/O: with a model that returns its input, the audio comes back unchanged', async () => {
  // Checks the 6144-point STFT, its inverse, the window layout and padding. Only bins 3..2047 reach the
  // model (22 Hz .. 14.7 kHz), so the test tone stays inside that band.
  const n = Math.round(9.3 * MDX_SR);
  const L = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / MDX_SR) + 0.2 * Math.sin((2 * Math.PI * 3150.7 * i) / MDX_SR));
  const R = Float32Array.from({ length: n }, (_, i) => 0.25 * Math.sin((2 * Math.PI * 1234.5 * i) / MDX_SR + 1) + 0.1 * Math.sin((2 * Math.PI * 9000 * i) / MDX_SR));
  let runs = 0;
  const identity = async (x) => { runs++; return x.data.slice(); };
  for (const overlap of [0, 0.25]) {
    runs = 0;
    const y = await vocalsStereo(L, R, identity, { overlap });
    const err = db((E(y.L, MDX_SR, n - MDX_SR) + E(y.R, MDX_SR, n - MDX_SR)) > 0
      ? (E(Float32Array.from(L, (v, i) => v - y.L[i]), MDX_SR, n - MDX_SR) + E(Float32Array.from(R, (v, i) => v - y.R[i]), MDX_SR, n - MDX_SR))
        / (E(L, MDX_SR, n - MDX_SR) + E(R, MDX_SR, n - MDX_SR)) : 1);
    console.log(`  overlap ${overlap}: ${runs} model runs, reconstruction error ${err.toFixed(1)} dB`);
    assert.ok(err < -60, `reconstruction error ${err.toFixed(1)} dB`);
    if (overlap === 0) assert.equal(runs, 2, `a ${(n / MDX_SR).toFixed(1)} s block should take two runs`);
  }
  assert.ok(MDX_TWO_RUNS > 11.6 && MDX_TWO_RUNS < 11.8);
});

const mrxFile = new URL('../models/mrx.int8.onnx', import.meta.url);
const mdxFile = new URL('../models/mdx-vocals.fp16w.onnx', import.meta.url);
const haveModels = existsSync(mrxFile) && existsSync(mdxFile);
test('separation job with the voice guard: a voice alone stays, held chords go, speech over chords gets clearer', { skip: !haveModels && 'run npm run fetch-model first' }, async () => {
  const ort = await import('onnxruntime-node');
  const { default: createRNNWasmModule } = await import('@jitsi/rnnoise-wasm/dist/rnnoise.js');
  const { createRnnoiseVoice } = await import('../src/dsp/rnnoise-voice.js');
  const { separateBlock } = await import('../src/sep/job.js');
  const wasm = readFileSync(new URL('../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
  const RNN = await createRNNWasmModule({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) });
  const mrx = await ort.InferenceSession.create(readFileSync(mrxFile));
  const mdx = await ort.InferenceSession.create(readFileSync(mdxFile));
  const run = async (feeds) => { const f = {}; for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor('float32', v.data, v.dims); return mrx.run(f); };
  const runVocals = async (x) => (await mdx.run({ [mdx.inputNames[0]]: new ort.Tensor('float32', x.data, x.dims) }))[mdx.outputNames[0]].data;
  const deps = { run, voiceModel: () => createRnnoiseVoice(RNN), runVocals };

  const raw = new Int16Array(readFileSync(new URL('./fixtures/voice-48k-mono.s16', import.meta.url)).buffer.slice(0));
  const voice = Float32Array.from(raw, (v) => (v / 32768) * 0.6);
  const music = chords(voice.length / SR).map((v) => v * 0.7);
  const mix = Float32Array.from(voice, (v, i) => v + 1.7 * music[i]);
  const keep = { music: 0, speech: 1, sfx: 0 };
  const v = await separateBlock(voice, voice, deps, { keep });
  const m = await separateBlock(music, music, deps, { keep });
  const s = await separateBlock(mix, mix, deps, { keep });
  const rn = await separateBlock(music, music, { run, voiceModel: deps.voiceModel }, { keep });
  const kv = db(E(v.L) / E(voice)), km = db(E(m.L) / E(music)), kr = db(E(rn.L) / E(music));
  // The fixture is a spoken voice, which MRX keeps as speech: over chords it is a vlog, not a song.
  const before = db(E(voice) / E(Float32Array.from(music, (x) => 1.7 * x)));
  const after = db(E(voice) / E(Float32Array.from(s.L, (x, i) => x - voice[i])));
  console.log(`  guard=${v.guard}: voice alone kept ${kv.toFixed(1)} dB; held chords ${km.toFixed(1)} dB (RNNoise guard: ${kr.toFixed(1)} dB); speech over chords: voice/rest ${before.toFixed(1)} → ${after.toFixed(1)} dB`);
  assert.equal(v.guard, 'vocals');
  assert.equal(rn.guard, 'rnnoise');
  assert.ok(kv > -3, `a voice alone dropped to ${kv.toFixed(1)} dB`);
  // The case the steady-pitch rule was written for: RNNoise calls clean held tones a voice. The vocals
  // model does not, so the chords go even with that rule off.
  assert.ok(km < -20, `held chords only reduced to ${km.toFixed(1)} dB`);
  assert.ok(km < kr - 6, 'the voice guard removes held chords far better than RNNoise');
  assert.ok(after - before > 6, `speech over chords only improved ${(after - before).toFixed(1)} dB`);
});
