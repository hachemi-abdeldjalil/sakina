// One separation job: a block of 48 kHz stereo audio in, the same block without music out.
//   48 kHz → 44.1 kHz → MRX (music / speech / sfx masks) → back to 48 kHz
//   → voice protection merged in (see fuse.js), so recitation and singing voices survive MRX.
//
// The voice estimate that protection uses comes from one of two places:
//   - the vocals model (mdx.js, "voice guard", since 0.5): a music vocals model that puts every human
//     voice in its vocals stem. Used whenever the worker could load it and keeps up.
//   - RNNoise (as before 0.5): cheap, but it calls clean held tones a voice and melodic recitation noise,
//     so its estimate needs two extra gates (voice activity, steady pitch) that also cost recitation.
import { separateStereo, MRX_SR } from './mrx.js';
import { vocalsStereo, MDX_SR } from './mdx.js';
import { resample } from './resample.js';
import { rnnoiseOffline, fuseVoice } from './fuse.js';
import { RNNOISE_FRAME } from '../dsp/rnnoise-voice.js';

export const V2_DEFAULTS = { protect: 1.3, vadLo: 0.6, vadHi: 0.9, dominance: [0.5, 0.75], song: [0.62, 0.74], keep: { music: 0, speech: 1, sfx: 1 } };
// With the vocals model as the voice estimate, the RNNoise-only gates go: no voice-activity gate and no
// steady-pitch rule. Measured on 19 real clips: recitation 14-35 % → 0-4 % removed, songs and music still
// 99-100 %, and held synthetic chords (what the steady-pitch rule was for) still removed in full.
// The vocals model's windows don't overlap: on the same clips that changed no result, and the job ran 26 %
// faster (2.28 → 2.88× real time).
export const GUARD_OPTS = { vadLo: -1, vadHi: 0, rockKeep: 1, vocalsOverlap: 0 };

const fit = (x, n) => (x.length === n ? x : (() => { const y = new Float32Array(n); y.set(x.subarray(0, Math.min(n, x.length))); return y; })());

/**
 * @param {Float32Array} L, R    48 kHz
 * @param {object} deps          { run: MRX session runner (see mrx.js), voiceModel: () => RNNoise voice model,
 *                                 runVocals?: vocals-model runner (see mdx.js); when given, it is the voice guard }
 * @param {object} [opts]        { protect (0..1.5), vadLo, vadHi, keep, ... (see fuse.js) }
 * @returns {Promise<{L: Float32Array, R: Float32Array, share: {music:number, speech:number, sfx:number}, guard: string}>}
 */
export async function separateBlock(L, R, deps, opts = {}) {
  const guard = deps.runVocals ? 'vocals' : 'rnnoise';
  const o = { ...V2_DEFAULTS, ...(guard === 'vocals' ? GUARD_OPTS : {}), ...opts };
  const n = L.length;
  const L44 = resample(L, 48000, MRX_SR), R44 = resample(R, 48000, MRX_SR);
  const r44 = await separateStereo(L44, R44, deps.run, o.keep);
  const sL = resample(r44.L, MRX_SR, 48000), sR = resample(r44.R, MRX_SR, 48000);
  let fz;
  if (!(o.protect > 0)) {
    fz = { L: sL.slice(0, n), R: sR.slice(0, n) };
  } else if (guard === 'vocals') {
    const v = await vocalsStereo(L44, R44, deps.runVocals, { overlap: o.vocalsOverlap }); // MDX_SR === MRX_SR: same 44.1 kHz input
    const vL = fit(resample(v.L, MDX_SR, 48000), n), vR = fit(resample(v.R, MDX_SR, 48000), n);
    const voice = new Float32Array(n);
    for (let i = 0; i < n; i++) voice[i] = 0.5 * (vL[i] + vR[i]);
    const vad = new Float32Array(Math.ceil(n / RNNOISE_FRAME)).fill(1); // unused: the gate is off (GUARD_OPTS)
    fz = fuseVoice(L, R, sL, sR, voice, vad, o);
  } else {
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]);
    const vm = deps.voiceModel();
    try {
      const { voice, vad } = rnnoiseOffline(mono, vm);
      fz = fuseVoice(L, R, sL, sR, voice, vad, o);
    } finally {
      vm.destroy?.();
    }
  }
  const tot = r44.energy.music + r44.energy.speech + r44.energy.sfx || 1;
  return {
    L: fz.L, R: fz.R, guard,
    share: { music: r44.energy.music / tot, speech: r44.energy.speech / tot, sfx: r44.energy.sfx / tot },
  };
}
