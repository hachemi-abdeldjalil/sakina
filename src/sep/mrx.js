// MRX dialogue / music / effects separation (MERL "Cocktail Fork", ONNX int8 export by audiojs).
//
// The ONNX graph takes magnitude STFTs at three resolutions of a MONO signal and returns a real
// mask per source (music, speech, sfx) and resolution. A source is the SUM over resolutions of
// iSTFT(mask × that resolution's complex spectrogram).
//
// Here the masks are computed on the mid (L+R)/2 signal and applied to both channels at once:
// left and right are packed into one complex FFT (Z = L + iR), and because the masks are real
// and symmetric, iFFT(mask·Z) = mask-applied L + i·(mask-applied R). Stereo costs the same as mono.
//
// Model I/O (upstream mrx.py): torch.stft, Hann (periodic), hop 256, normalized=True (×1/√n),
// center=True with reflect padding, at 44.1 kHz; input brought to −27 LUFS first.
import { FFT } from '../dsp/fft.js';

export const MRX_SR = 44100;
export const MRX_HOP = 256;
export const MRX_RES = [1024, 2048, 8192];
export const SOURCES = ['music', 'speech', 'sfx'];

const ffts = new Map();
const wins = new Map();
function fftOf(n) {
  if (!ffts.has(n)) ffts.set(n, new FFT(n));
  if (!wins.has(n)) wins.set(n, Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)));
  return [ffts.get(n), wins.get(n)];
}

const reflect = (j, len) => {
  while (j < 0 || j >= len) j = j < 0 ? -j : 2 * (len - 1) - j;
  return j;
};

// Centered, reflect-padded STFT of Z = L + iR. Returns { re, im } as [frame][bin] in flat arrays (frames × n).
function stftStereo(L, R, n) {
  const [fft, win] = fftOf(n);
  const len = L.length, pad = n / 2;
  const T = Math.floor(len / MRX_HOP) + 1;
  const re = new Float32Array(T * n), im = new Float32Array(T * n);
  const fr = new Float64Array(n), fi = new Float64Array(n);
  const scale = 1 / Math.sqrt(n);
  for (let t = 0; t < T; t++) {
    const start = t * MRX_HOP - pad;
    for (let i = 0; i < n; i++) {
      const j = reflect(start + i, len);
      fr[i] = L[j] * win[i] * scale;
      fi[i] = R[j] * win[i] * scale;
    }
    fft.transform(fr, fi, false);
    re.set(fr, t * n);
    im.set(fi, t * n);
  }
  return { re, im, T, n };
}

// Mid-channel magnitude [1, bins, T] from the packed stereo spectrum.
function midMagnitude({ re, im, T, n }) {
  const bins = n / 2 + 1;
  const out = new Float32Array(bins * T);
  for (let t = 0; t < T; t++) {
    const o = t * n;
    for (let k = 0; k < bins; k++) {
      const j = (n - k) % n;
      // XL = (Z[k] + conj Z[j]) / 2, XR = (Z[k] − conj Z[j]) / 2i, mid = (XL + XR) / 2
      const mr = 0.25 * (re[o + k] + re[o + j] + im[o + k] + im[o + j]);
      const mi = 0.25 * (im[o + k] - im[o + j] - re[o + k] + re[o + j]);
      out[k * T + t] = Math.sqrt(mr * mr + mi * mi);
    }
  }
  return out;
}

// Inverse of stftStereo after applying a real mask [bins, T]; adds into outL/outR.
function istftStereoMasked(spec, mask, outL, outR) {
  const { re, im, T, n } = spec;
  const [fft, win] = fftOf(n);
  const bins = n / 2 + 1, len = outL.length, pad = n / 2;
  const accL = new Float64Array(len + n), accR = new Float64Array(len + n), wsum = new Float64Array(len + n);
  const fr = new Float64Array(n), fi = new Float64Array(n);
  const scale = Math.sqrt(n) / n; // undo normalized=True, and 1/n of the inverse FFT
  for (let t = 0; t < T; t++) {
    const o = t * n;
    for (let k = 0; k < bins; k++) {
      const m = mask[k * T + t];
      fr[k] = re[o + k] * m; fi[k] = im[o + k] * m;
      const j = (n - k) % n;
      if (j !== k) { fr[j] = re[o + j] * m; fi[j] = im[o + j] * m; }
    }
    fft.transform(fr, fi, true);
    const s = t * MRX_HOP;
    for (let i = 0; i < n; i++) {
      accL[s + i] += fr[i] * scale * win[i];
      accR[s + i] += fi[i] * scale * win[i];
      wsum[s + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < len; i++) {
    const w = wsum[i + pad];
    if (w > 1e-8) { outL[i] += accL[i + pad] / w; outR[i] += accR[i + pad] / w; }
  }
}

// Rough integrated loudness (unweighted, gated at −70 LUFS): good enough to bring the input near −27 LUFS.
export function roughLufs(L, R) {
  const block = Math.round(0.4 * MRX_SR), step = Math.round(0.1 * MRX_SR);
  let sum = 0, count = 0;
  for (let s = 0; s + block <= L.length; s += step) {
    let e = 0;
    for (let i = s; i < s + block; i++) e += L[i] * L[i] + R[i] * R[i];
    const ms = e / block;
    if (-0.691 + 10 * Math.log10(ms + 1e-12) > -70) { sum += ms; count++; }
  }
  return count ? -0.691 + 10 * Math.log10(sum / count) : -70;
}

/**
 * Separate one stereo chunk at 44.1 kHz.
 * @param {Float32Array} L, R  equal length
 * @param {(feeds: object) => Promise<object>} run  runs the ONNX session: feeds {mag_1024,mag_2048,mag_8192} as
 *        {data: Float32Array, dims: number[]}; returns {mask_1024, mask_2048, mask_8192} with .data
 * @param {object} keep  weight per source, e.g. { music: 0, speech: 1, sfx: 1 }
 * @returns {{ L: Float32Array, R: Float32Array, energy: {music,speech,sfx} }}
 */
export async function separateStereo(L, R, run, keep = { music: 0, speech: 1, sfx: 1 }, gainDb = null) {
  const len = L.length;
  const lufs = gainDb === null ? roughLufs(L, R) : null;
  const g = gainDb === null ? Math.pow(10, Math.min(30, Math.max(-30, -27 - lufs)) / 20) : Math.pow(10, gainDb / 20);
  const Ls = new Float32Array(len), Rs = new Float32Array(len);
  for (let i = 0; i < len; i++) { Ls[i] = L[i] * g; Rs[i] = R[i] * g; }

  const specs = MRX_RES.map((n) => stftStereo(Ls, Rs, n));
  const feeds = {};
  for (const s of specs) feeds[`mag_${s.n}`] = { data: midMagnitude(s), dims: [1, s.n / 2 + 1, s.T] };
  const out = await run(feeds);

  const outL = new Float32Array(len), outR = new Float32Array(len);
  const energy = { music: 0, speech: 0, sfx: 0 };
  for (const s of specs) {
    const bins = s.n / 2 + 1, T = s.T;
    const masks = out[`mask_${s.n}`].data; // [1, 3, bins, T]
    const mag = feeds[`mag_${s.n}`].data;  // [1, bins, T]
    const combined = new Float32Array(bins * T);
    for (let src = 0; src < 3; src++) {
      const w = keep[SOURCES[src]] ?? 0;
      const base = src * bins * T;
      let e = 0;
      for (let q = 0; q < bins * T; q++) {
        const m = masks[base + q];
        if (w) combined[q] += w * m;
        const v = m * mag[q];
        e += v * v; // masked energy: each source's share, for status display and tests
      }
      energy[SOURCES[src]] += e;
    }
    istftStereoMasked(s, combined, outL, outR);
  }
  const inv = 1 / g;
  for (let i = 0; i < len; i++) { outL[i] *= inv; outR[i] *= inv; }
  return { L: outL, R: outR, energy };
}
