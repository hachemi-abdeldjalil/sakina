// Voice protection with the real RNNoise model and a real (synthesised) voice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';
import { MusicSuppressor } from '../src/dsp/suppressor.js';
import { createRnnoiseVoice } from '../src/dsp/rnnoise-voice.js';
import { SR, chords, effects } from './signals.mjs';

const wasm = readFileSync(new URL('../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
const Module = await createRNNWasmModule({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) });

const raw = new Int16Array(readFileSync(new URL('./fixtures/voice-48k-mono.s16', import.meta.url)).buffer.slice(0));
const voice = Float32Array.from(raw, (v) => (v / 32768) * 0.6);
const SKIP = SR; // warm-up

function run(x, opts) {
  const s = new MusicSuppressor(SR, { strength: 0.8, voiceFocus: 0, ...opts });
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const e = Math.min(x.length, i + 128);
    s.process(x.subarray(i, e), x.subarray(i, e), y.subarray(i, e), null);
  }
  return { y, latency: s.latency };
}
const energy = (x, a = SKIP, b = x.length) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return e; };
const db = (r) => 10 * Math.log10(r);

test('with voice protection, a real voice keeps (almost) all of its energy', () => {
  const plain = db(energy(run(voice, {}).y) / energy(voice));
  const prot = db(energy(run(voice, { voice: createRnnoiseVoice(Module) }).y) / energy(voice));
  console.log(`  voice kept: ${plain.toFixed(1)} dB without protection, ${prot.toFixed(1)} dB with`);
  assert.ok(prot > -1.5, `voice dropped to ${prot.toFixed(1)} dB`);
  assert.ok(prot >= plain - 0.1, 'protection never removes more voice');
});

test('with voice protection, held chords alone are still cut', () => {
  const m = chords(voice.length / SR);
  const k = db(energy(run(m, { voice: createRnnoiseVoice(Module) }).y) / energy(m));
  console.log(`  chords kept with protection on: ${k.toFixed(1)} dB`);
  assert.ok(k < -8, `chords only reduced to ${k.toFixed(1)} dB`);
});

test('voice over music: voice-to-music ratio improves', () => {
  const music = chords(voice.length / SR).map((v) => v * 0.7);
  const mix = Float32Array.from(voice, (v, i) => v + music[i]);
  const { y, latency } = run(mix, { voice: createRnnoiseVoice(Module) });
  let tE = 0, mE = 0, errE = 0;
  for (let i = SKIP; i < mix.length; i++) {
    const t = voice[i - latency] ?? 0;
    tE += t * t; mE += (music[i - latency] ?? 0) ** 2; errE += (y[i] - t) ** 2;
  }
  const before = db(tE / mE), after = db(tE / errE);
  console.log(`  voice/music before ${before.toFixed(1)} dB → after ${after.toFixed(1)} dB`);
  assert.ok(after - before > 3, `only improved ${(after - before).toFixed(1)} dB`);
});

test('keepSfx off: sound effects are cut too, the voice stays', () => {
  const fx = effects(voice.length / SR).map((v) => v * 1.5);
  const mix = Float32Array.from(voice, (v, i) => v + fx[i]);
  const measure = (keepSfx) => {
    const { y, latency } = run(mix, { voice: createRnnoiseVoice(Module), keepSfx });
    let tE = 0, fE = 0, errE = 0;
    for (let i = SKIP; i < mix.length; i++) {
      const t = voice[i - latency] ?? 0;
      tE += t * t; fE += (fx[i - latency] ?? 0) ** 2; errE += (y[i] - t) ** 2;
    }
    return { before: db(tE / fE), after: db(tE / errE) };
  };
  const keep = measure(true), drop = measure(false);
  const fxOnly = (keepSfx) => db(energy(run(fx, { voice: createRnnoiseVoice(Module), keepSfx }).y) / energy(fx));
  const kept = fxOnly(true), dropped = fxOnly(false);
  const voiceOnly = db(energy(run(voice, { voice: createRnnoiseVoice(Module), keepSfx: false }).y) / energy(voice));
  console.log(`  effects alone kept: ${kept.toFixed(1)} dB (keep on) vs ${dropped.toFixed(1)} dB (off); voice alone with off: ${voiceOnly.toFixed(1)} dB; voice/effects in a mix: ${keep.after.toFixed(1)} → ${drop.after.toFixed(1)} dB`);
  assert.ok(kept > -3, `effects already cut with keepSfx on (${kept.toFixed(1)} dB)`);
  assert.ok(dropped < kept - 10, `keepSfx off only cut effects to ${dropped.toFixed(1)} dB`);
  assert.ok(voiceOnly > -3, `voice dropped to ${voiceOnly.toFixed(1)} dB with keepSfx off`);
  // Effects that land on top of a word stay partly (the voice model hears voice there): ~3 dB better.
  assert.ok(drop.after > keep.after + 2, 'voice-to-effects ratio improves with keepSfx off');
});

test('voice dominance: high for a voice alone, low for a voice over music', async () => {
  const { rnnoiseOffline, voiceDominance } = await import('../src/sep/fuse.js');
  const music = chords(voice.length / SR).map((v) => v * 1.2);
  const mix = Float32Array.from(voice, (v, i) => v + music[i]);
  const mean = (x) => {
    const { voice: est } = rnnoiseOffline(x, createRnnoiseVoice(Module));
    const d = voiceDominance(x, x, est);
    let s = 0; for (let f = 100; f < d.length - 100; f++) s += d[f];
    return s / (d.length - 200);
  };
  const alone = mean(voice), over = mean(mix);
  console.log(`  dominance: voice alone ${alone.toFixed(2)}, voice over chords ${over.toFixed(2)}`);
  assert.ok(alone > 0.8, 'a voice on its own keeps its protection');
  assert.ok(over < alone - 0.3, 'protection is mostly withdrawn when instruments play under the voice');
});
