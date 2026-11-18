import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicSuppressor } from '../src/dsp/suppressor.js';
import { SR, chords, melody, speech, effects, add } from './signals.mjs';

const SEC = 6;
const SKIP = Math.round(0.8 * SR); // let the tracker warm up

function run(x, params = {}, xr = x) {
  const s = new MusicSuppressor(SR, params);
  const outL = new Float32Array(x.length), outR = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const e = Math.min(x.length, i + 128);
    s.process(x.subarray(i, e), xr.subarray(i, e), outL.subarray(i, e), outR.subarray(i, e));
  }
  return { outL, outR, latency: s.latency };
}

const energy = (x, from = SKIP, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e;
};
const db = (r) => 10 * Math.log10(r);
const keptDb = (x, p) => db(energy(run(x, p).outL) / energy(x));

test('strength 0 is a clean pass-through delayed by one frame', () => {
  const x = add(speech(2), chords(2), effects(2));
  const { outL, latency } = run(x, { strength: 0, voiceFocus: 0 });
  let err = 0, ref = 0;
  for (let i = latency + 4096; i < x.length; i++) {
    err += (outL[i] - x[i - latency]) ** 2;
    ref += x[i - latency] ** 2;
  }
  assert.ok(db(err / ref) < -80, `reconstruction error ${db(err / ref).toFixed(1)} dB`);
});

test('held chords are cut hard', () => {
  const k = keptDb(chords(SEC), { strength: 0.8, voiceFocus: 0 });
  console.log(`  chords kept: ${k.toFixed(1)} dB`);
  assert.ok(k < -11, `chords only reduced to ${k.toFixed(1)} dB`);
});

test('short melody notes are reduced', () => {
  const k = keptDb(melody(SEC), { strength: 0.8, voiceFocus: 0 });
  console.log(`  melody kept: ${k.toFixed(1)} dB`);
  assert.ok(k < -4.5, `melody only reduced to ${k.toFixed(1)} dB`);
});

test('speech is mostly kept', () => {
  const k = keptDb(speech(SEC), { strength: 0.8, voiceFocus: 0 });
  console.log(`  speech kept: ${k.toFixed(1)} dB`);
  assert.ok(k > -3, `speech dropped to ${k.toFixed(1)} dB`);
});

test('sound effects are mostly kept', () => {
  const k = keptDb(effects(SEC), { strength: 0.8, voiceFocus: 0 });
  console.log(`  effects kept: ${k.toFixed(1)} dB`);
  assert.ok(k > -2, `effects dropped to ${k.toFixed(1)} dB`);
});

test('in a mix, voice+effects to music ratio improves a lot', () => {
  const target = add(speech(SEC), effects(SEC));
  const music = chords(SEC);
  const mix = add(target, music);
  const { outL, latency } = run(mix, { strength: 0.8, voiceFocus: 0 });
  let tE = 0, errE = 0, mE = 0;
  for (let i = SKIP; i < mix.length; i++) {
    const tt = target[i - latency];
    tE += tt * tt;
    mE += music[i - latency] ** 2;
    errE += (outL[i] - tt) ** 2;
  }
  const before = db(tE / mE), after = db(tE / errE);
  console.log(`  ratio before ${before.toFixed(1)} dB → after ${after.toFixed(1)} dB`);
  assert.ok(after - before > 6, `only improved ${(after - before).toFixed(1)} dB`);
});

test('voice focus turns down sound panned to the sides', () => {
  const m = melody(SEC);
  const neg = m.map((v) => -v); // pure side signal
  const s = new MusicSuppressor(SR, { strength: 0, voiceFocus: 1 });
  const oL = new Float32Array(m.length), oR = new Float32Array(m.length);
  s.process(m, neg, oL, oR);
  const k = db(energy(oL) / energy(m));
  assert.ok(k < -12, `side only reduced to ${k.toFixed(1)} dB`);
});

test('runs faster than real time with a big margin', () => {
  const x = add(speech(10), chords(10));
  const t = performance.now();
  run(x, { strength: 0.8 });
  const ms = performance.now() - t;
  console.log(`  10 s of stereo audio in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000, `too slow: ${ms} ms for 10 s`);
});
