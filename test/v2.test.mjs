// v2 building blocks: timeline, alignment, chunk player, and one real separation job (MRX + RNNoise).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PcmTimeline } from '../src/sep/timeline.js';
import { alignSnippet } from '../src/sep/align.js';
import { ChunkPlayer } from '../src/audio/player.js';
import { resample } from '../src/sep/resample.js';
import { SR, chords, speech, effects, add } from './signals.mjs';

test('timeline: writes across slot edges, reads back, reports coverage', () => {
  const tl = new PcmTimeline(48000);
  const a = Float32Array.from({ length: 72000 }, (_, i) => Math.sin(i / 50));
  tl.write(24000, a, a); // 0.5 s .. 2.0 s
  assert.ok(Math.abs(tl.coverage(0.5, 2.0) - 1) < 1e-9);
  assert.ok(tl.coverage(0, 0.5) < 0.05);
  const { L } = tl.read(1.0, 1.5);
  for (let i = 0; i < L.length; i += 997) assert.ok(Math.abs(L[i] - a[24000 + i]) < 1e-6);
  tl.evict(1.5, 10);
  assert.equal(tl.coverage(0.5, 0.9), 0);
  assert.ok(tl.coverage(1.0, 2.0) > 0.99);
});

test('resampler: 48 → 44.1 → 48 kHz round trip is clean', () => {
  const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000) + 0.5 * Math.sin((2 * Math.PI * 15000 * i) / 48000));
  const y = resample(resample(x, 48000, 44100), 44100, 48000);
  let e = 0, d = 0;
  for (let i = 2000; i < 46000; i++) { e += x[i] ** 2; d += (y[i] - x[i]) ** 2; }
  assert.ok(10 * Math.log10(d / e) < -60);
});

test('alignment finds the exact offset of a live snippet, even quieter and noisier', () => {
  const ref = add(speech(4), chords(4), effects(4));
  const trueLag = 37321;
  const snippet = Float32Array.from({ length: 16384 }, (_, i) => 0.5 * ref[trueLag + i] + 0.002 * Math.sin(i * 1.7));
  const { lag, score, scale } = alignSnippet(snippet, ref);
  assert.equal(lag, trueLag);
  assert.ok(score > 0.98, `score ${score}`);
  assert.ok(Math.abs(scale - 0.5) < 0.02, `scale ${scale}`);
});

test('alignment of silence reports a zero score', () => {
  assert.equal(alignSnippet(new Float32Array(16384), speech(2)).score, 0);
});

test('player: plays the right samples for the mapped media time and crossfades chunk overlaps', () => {
  const sr = 48000, p = new ChunkPlayer(sr);
  const ramp = (start, n) => Float32Array.from({ length: n }, (_, i) => start + i / sr); // value = media time
  p.addChunk(0, ramp(0, sr * 2 + 2400), ramp(0, sr * 2 + 2400));              // 0 .. 2.05 s
  p.addChunk(1.95, ramp(1.95, sr * 2), ramp(1.95, sr * 2));                     // 1.95 .. 3.95 s
  p.setMap(1000, 0.5);                                                          // frame 1000 ↔ 0.5 s
  const L = new Float32Array(128), R = new Float32Array(128);
  assert.ok(p.render(1000 + sr, 128, L, R));                                    // media 1.5 s
  assert.ok(Math.abs(L[0] - 1.5) < 1e-4 && Math.abs(L[127] - (1.5 + 127 / sr)) < 1e-4);
  assert.ok(p.render(1000 + 1.5 * sr, 128, L, R));                              // media 2.0 s, in the overlap
  assert.ok(Math.abs(L[0] - 2.0) < 1e-3, `crossfaded value ${L[0]}`);           // both chunks agree here
  assert.ok(Math.abs(p.readyAhead(0.5) - 3.45) < 1e-3);
  assert.equal(p.render(1000 + 4 * sr, 128, L, R), false);                     // past the end → fallback
  p.clearMap();
  assert.equal(p.render(1000, 128, L, R), false);
});

const model = new URL('../models/mrx.int8.onnx', import.meta.url);
test('separation job (MRX + voice protection) keeps a real voice and removes held chords', { skip: !existsSync(model) && 'run npm run fetch-model first' }, async () => {
  const ort = await import('onnxruntime-node');
  const { default: createRNNWasmModule } = await import('@jitsi/rnnoise-wasm/dist/rnnoise.js');
  const { createRnnoiseVoice } = await import('../src/dsp/rnnoise-voice.js');
  const { separateBlock } = await import('../src/sep/job.js');
  const wasm = readFileSync(new URL('../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
  const RNN = await createRNNWasmModule({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) });
  const sess = await ort.InferenceSession.create(readFileSync(model));
  const run = async (feeds) => { const f = {}; for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor('float32', v.data, v.dims); return sess.run(f); };
  const deps = { run, voiceModel: () => createRnnoiseVoice(RNN) };

  const raw = new Int16Array(readFileSync(new URL('./fixtures/voice-48k-mono.s16', import.meta.url)).buffer.slice(0));
  const voice = Float32Array.from(raw, (v) => (v / 32768) * 0.6);
  const music = chords(voice.length / SR).map((v) => v * 0.7);
  const E = (a) => { let e = 0; for (let i = SR; i < a.length - SR; i++) e += a[i] * a[i]; return e; };
  const db = (r) => 10 * Math.log10(r);

  const v = await separateBlock(voice, voice, deps);
  const m = await separateBlock(music, music, deps);
  const kv = db(E(v.L) / E(voice)), km = db(E(m.L) / E(music));
  console.log(`  voice kept ${kv.toFixed(1)} dB, chords kept ${km.toFixed(1)} dB; voice clip share: ${JSON.stringify(Object.fromEntries(Object.entries(v.share).map(([k, x]) => [k, +x.toFixed(2)])))}`);
  assert.ok(kv > -2, `voice dropped to ${kv.toFixed(1)} dB`);
  // Perfect synthetic harmonics fool RNNoise into "voice", so protection keeps part of them; real
  // instruments fare much better (recorded piano: 87% of its energy removed). Guard against regressions.
  assert.ok(km < -6, `chords only reduced to ${km.toFixed(1)} dB`);
});

test('separation job with sfx: 0 keeps a real voice and removes far more of the effects', { skip: !existsSync(model) && 'run npm run fetch-model first' }, async () => {
  const ort = await import('onnxruntime-node');
  const { default: createRNNWasmModule } = await import('@jitsi/rnnoise-wasm/dist/rnnoise.js');
  const { createRnnoiseVoice } = await import('../src/dsp/rnnoise-voice.js');
  const { separateBlock } = await import('../src/sep/job.js');
  const wasm = readFileSync(new URL('../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
  const RNN = await createRNNWasmModule({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) });
  const sess = await ort.InferenceSession.create(readFileSync(model));
  const run = async (feeds) => { const f = {}; for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor('float32', v.data, v.dims); return sess.run(f); };
  const deps = { run, voiceModel: () => createRnnoiseVoice(RNN) };
  const raw = new Int16Array(readFileSync(new URL('./fixtures/voice-48k-mono.s16', import.meta.url)).buffer.slice(0));
  const voice = Float32Array.from(raw, (v) => (v / 32768) * 0.6);
  const fx = effects(voice.length / SR).map((v) => v * 1.5);
  const E = (a) => { let e = 0; for (let i = SR; i < a.length - SR; i++) e += a[i] * a[i]; return e; };
  const db = (r) => 10 * Math.log10(r);
  const noSfx = { keep: { music: 0, speech: 1, sfx: 0 } };

  const fxKeep = db(E((await separateBlock(fx, fx, deps)).L) / E(fx));
  const fxDrop = db(E((await separateBlock(fx, fx, deps, noSfx)).L) / E(fx));
  const vDrop = db(E((await separateBlock(voice, voice, deps, noSfx)).L) / E(voice));
  console.log(`  effects kept ${fxKeep.toFixed(1)} dB (sfx 1) vs ${fxDrop.toFixed(1)} dB (sfx 0); voice kept ${vDrop.toFixed(1)} dB with sfx 0`);
  assert.ok(fxDrop < fxKeep - 6, `sfx 0 only took effects from ${fxKeep.toFixed(1)} to ${fxDrop.toFixed(1)} dB`);
  assert.ok(vDrop > -2, `voice dropped to ${vDrop.toFixed(1)} dB with sfx 0`);
});
