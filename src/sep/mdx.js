// UVR-MDX-NET vocals model (UVR_MDXNET_1_9703, by the Ultimate Vocal Remover team), Sakina's voice
// guard in AI mode. A music "vocals" model puts every human voice in its vocals stem, spoken, sung or
// recited, so it tells fuse.js where a voice really is. RNNoise, which did that job before, mistakes
// clean held tones for a voice and melodic recitation for noise.
//
// Model I/O, as in python-audio-separator's MDX path: 44.1 kHz stereo in windows of 256 STFT frames
// (n_fft 6144, hop 1024, periodic Hann, center=True with reflect padding, not normalized). Input and
// output are [1, 4, 2048, 256] = [L re, L im, R re, R im] × the lowest 2048 bins × frames, with bins 0-2
// zeroed on the way in. Windows overlap by 25 % and are blended with a Hann window.
import { FFT } from '../dsp/fft.js';

export const MDX_SR = 44100;
const N = 6144, HOP = 1024, DIMF = 2048, DIMT = 256;
const CHUNK = HOP * (DIMT - 1); // 261120 samples ≈ 5.92 s per model run
const TRIM = N / 2;
const GEN = CHUNK - 2 * TRIM;
/** Longest block (s) that takes two model runs without overlap; one run up to half of this. */
export const MDX_TWO_RUNS = (2 * CHUNK - 2 * TRIM) / 44100;
const PEAK = 0.9;                      // louder mixes are scaled down to this peak first (and back after)

// 6144-point FFT: three interleaved 2048-point FFTs, then one radix-3 pass.
// inverse=true is the unscaled conjugate transform, as in dsp/fft.js.
class FFT6144 {
  constructor() {
    this.sub = new FFT(2048);
    this.cos = Float64Array.from({ length: N }, (_, k) => Math.cos((2 * Math.PI * k) / N));
    this.sin = Float64Array.from({ length: N }, (_, k) => Math.sin((2 * Math.PI * k) / N));
    this.br = [0, 1, 2].map(() => new Float64Array(2048));
    this.bi = [0, 1, 2].map(() => new Float64Array(2048));
  }

  transform(re, im, inverse = false) {
    const { sub, cos, sin, br, bi } = this;
    for (let r = 0; r < 3; r++) {
      const a = br[r], b = bi[r];
      for (let j = 0; j < 2048; j++) { a[j] = re[3 * j + r]; b[j] = im[3 * j + r]; }
      sub.transform(a, b, inverse);
    }
    const s = inverse ? 1 : -1;
    for (let k = 0; k < N; k++) {
      const q = k & 2047;
      let xr = br[0][q], xi = bi[0][q];
      const i1 = k % N, i2 = (2 * k) % N;
      const w1r = cos[i1], w1i = s * sin[i1], w2r = cos[i2], w2i = s * sin[i2];
      xr += br[1][q] * w1r - bi[1][q] * w1i + br[2][q] * w2r - bi[2][q] * w2i;
      xi += br[1][q] * w1i + bi[1][q] * w1r + br[2][q] * w2i + bi[2][q] * w2r;
      re[k] = xr; im[k] = xi;
    }
  }
}

let fft = null, win = null;
const setup = () => {
  fft ??= new FFT6144();
  win ??= Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
};
const reflect = (j, len) => {
  while (j < 0 || j >= len) j = j < 0 ? -j : 2 * (len - 1) - j;
  return j;
};

// STFT of one model window (L, R from `off`, CHUNK samples) into the model's input layout.
function windowSpec(L, R, off, input) {
  const fr = new Float64Array(N), fi = new Float64Array(N);
  for (let t = 0; t < DIMT; t++) {
    const start = t * HOP - TRIM;
    for (let i = 0; i < N; i++) {
      const j = off + reflect(start + i, CHUNK);
      fr[i] = L[j] * win[i]; fi[i] = R[j] * win[i];
    }
    fft.transform(fr, fi, false); // Z = FFT(L + iR)
    for (let f = 3; f < DIMF; f++) {
      const j = (N - f) % N;
      const a = fr[f], b = fi[f], c = fr[j], d = fi[j];
      input[(0 * DIMF + f) * DIMT + t] = 0.5 * (a + c); // L re
      input[(1 * DIMF + f) * DIMT + t] = 0.5 * (b - d); // L im
      input[(2 * DIMF + f) * DIMT + t] = 0.5 * (b + d); // R re
      input[(3 * DIMF + f) * DIMT + t] = 0.5 * (c - a); // R im
    }
  }
}

// Inverse STFT of the model's output for one window; returns CHUNK samples per channel.
function windowWave(spec) {
  const fr = new Float64Array(N), fi = new Float64Array(N);
  const accL = new Float64Array(CHUNK + N), accR = new Float64Array(CHUNK + N), wsum = new Float64Array(CHUNK + N);
  for (let t = 0; t < DIMT; t++) {
    fr.fill(0); fi.fill(0);
    for (let f = 0; f < DIMF; f++) {
      const lr = spec[(0 * DIMF + f) * DIMT + t], li = spec[(1 * DIMF + f) * DIMT + t];
      const rr = spec[(2 * DIMF + f) * DIMT + t], ri = spec[(3 * DIMF + f) * DIMT + t];
      if (f === 0) { fr[0] = lr; fi[0] = rr; continue; } // the DC bin is real (irfft drops its imaginary part)
      fr[f] = lr - ri; fi[f] = li + rr;         // Z[f]     = XL + i·XR
      fr[N - f] = lr + ri; fi[N - f] = rr - li; // Z[N − f] = conj(XL) + i·conj(XR)
    }
    fft.transform(fr, fi, true);
    const s = t * HOP;
    for (let i = 0; i < N; i++) {
      accL[s + i] += (fr[i] / N) * win[i];
      accR[s + i] += (fi[i] / N) * win[i];
      wsum[s + i] += win[i] * win[i];
    }
  }
  const L = new Float32Array(CHUNK), R = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    const w = wsum[i + TRIM];
    if (w > 1e-8) { L[i] = accL[i + TRIM] / w; R[i] = accR[i + TRIM] / w; }
  }
  return { L, R };
}

/**
 * The vocals (every human voice) of a 44.1 kHz stereo block.
 * @param {Float32Array} L, R  equal length
 * @param {(input: {data: Float32Array, dims: number[]}) => Promise<Float32Array>} run  runs the ONNX session
 * @param {object} [o]  { overlap: share of each model window shared with the next (0..0.5) }
 * @returns {Promise<{ L: Float32Array, R: Float32Array }>}
 */
export async function vocalsStereo(L, R, run, o = {}) {
  setup();
  const overlap = o.overlap ?? 0.25;
  const STEP = Math.floor((1 - overlap) * CHUNK);
  const n = L.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > PEAK ? PEAK / peak : 1;
  // [TRIM zeros | block | zeros up to whole windows]. With overlap, padded as audio-separator's demix does;
  // without, only as far as the last window needs (a block of up to 2·CHUNK − 2·TRIM samples, 11.7 s, takes
  // two model runs instead of three).
  const M = overlap > 0 ? TRIM + n + (GEN + TRIM - (n % GEN)) : Math.max(1, Math.ceil((n + 2 * TRIM) / CHUNK)) * CHUNK;
  const mL = new Float32Array(M), mR = new Float32Array(M);
  for (let i = 0; i < n; i++) { mL[TRIM + i] = L[i] * g; mR[TRIM + i] = R[i] * g; }
  const outL = new Float64Array(M), outR = new Float64Array(M), div = new Float64Array(M);
  const wL = new Float32Array(CHUNK), wR = new Float32Array(CHUNK);
  const input = new Float32Array(4 * DIMF * DIMT);
  for (let start = 0; start < M; start += STEP) {
    const len = Math.min(CHUNK, M - start);
    wL.fill(0); wR.fill(0);
    wL.set(mL.subarray(start, start + len)); wR.set(mR.subarray(start, start + len));
    input.fill(0);
    windowSpec(wL, wR, 0, input);
    const spec = await run({ data: input, dims: [1, 4, DIMF, DIMT] });
    const y = windowWave(spec);
    for (let i = 0; i < len; i++) {
      // overlapping windows are blended with np.hanning(len); without overlap each sample has one window
      const w = overlap > 0 && len > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)) : 1;
      outL[start + i] += y.L[i] * w; outR[start + i] += y.R[i] * w; div[start + i] += w;
    }
  }
  const vL = new Float32Array(n), vR = new Float32Array(n), inv = 1 / g;
  for (let i = 0; i < n; i++) {
    const d = div[TRIM + i];
    if (d > 1e-8) { vL[i] = (outL[TRIM + i] / d) * inv; vR[i] = (outR[TRIM + i] / d) * inv; }
  }
  return { L: vL, R: vR };
}
