// One separation job: a block of 48 kHz stereo audio in, the same block without music out.
//   48 kHz → 44.1 kHz → MRX (music / speech / sfx masks) → back to 48 kHz
//   → RNNoise voice protection merged in (see fuse.js), so recitation and singing voices survive.
import { separateStereo, MRX_SR } from './mrx.js';
import { resample } from './resample.js';
import { rnnoiseOffline, fuseVoice } from './fuse.js';

export const V2_DEFAULTS = { protect: 1.3, vadLo: 0.6, vadHi: 0.9, keep: { music: 0, speech: 1, sfx: 1 } };

/**
 * @param {Float32Array} L, R    48 kHz
 * @param {object} deps          { run: MRX session runner (see mrx.js), voiceModel: () => RNNoise voice model }
 * @param {object} [opts]        { protect (0..1.5), vadLo, vadHi, keep }
 * @returns {Promise<{L: Float32Array, R: Float32Array, share: {music:number, speech:number, sfx:number}}>}
 */
export async function separateBlock(L, R, deps, opts = {}) {
  const o = { ...V2_DEFAULTS, ...opts };
  const n = L.length;
  const r44 = await separateStereo(resample(L, 48000, MRX_SR), resample(R, 48000, MRX_SR), deps.run, o.keep);
  const sL = resample(r44.L, MRX_SR, 48000), sR = resample(r44.R, MRX_SR, 48000);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const vm = deps.voiceModel();
  let fz;
  try {
    const { voice, vad } = rnnoiseOffline(mono, vm);
    fz = o.protect > 0 ? fuseVoice(L, R, sL, sR, voice, vad, o) : { L: sL.slice(0, n), R: sR.slice(0, n) };
  } finally {
    vm.destroy?.();
  }
  const tot = r44.energy.music + r44.energy.speech + r44.energy.sfx || 1;
  return {
    L: fz.L, R: fz.R,
    share: { music: r44.energy.music / tot, speech: r44.energy.speech / tot, sfx: r44.energy.sfx / tot },
  };
}
