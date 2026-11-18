// Find where a short live recording sits inside a longer reference, by normalised cross-correlation
// (FFT based). Used to lock the separated track to what the video element is really playing.
import { FFT } from '../dsp/fft.js';

const ffts = new Map();
const fftOf = (n) => { if (!ffts.has(n)) ffts.set(n, new FFT(n)); return ffts.get(n); };

/**
 * @param {Float32Array} snippet  live audio (mono), length N
 * @param {Float32Array} ref      decoded original (mono), length M ≥ N
 * @returns {{ lag: number, score: number, scale: number }}  snippet[i] ≈ scale · ref[lag + i]
 */
export function alignSnippet(snippet, ref) {
  const N = snippet.length, M = ref.length;
  if (M < N || N < 64) return { lag: 0, score: 0, scale: 0 };
  let size = 1;
  while (size < M + N) size <<= 1;
  const fft = fftOf(size);
  // Pack both real signals into one complex FFT: Z = ref + i·snippet.
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(ref);
  for (let i = 0; i < N; i++) im[i] = snippet[i];
  fft.transform(re, im, false);
  // A = FFT(ref), B = FFT(snippet); cross-spectrum C = A · conj(B)
  const cr = new Float64Array(size), ci = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const j = (size - k) % size;
    const ar = 0.5 * (re[k] + re[j]), ai = 0.5 * (im[k] - im[j]);
    const br = 0.5 * (im[k] + im[j]), bi = -0.5 * (re[k] - re[j]);
    cr[k] = ar * br + ai * bi;
    ci[k] = ai * br - ar * bi;
  }
  fft.transform(cr, ci, true);

  let es = 0;
  for (let i = 0; i < N; i++) es += snippet[i] * snippet[i];
  if (es < 1e-9) return { lag: 0, score: 0, scale: 0 };
  // Sliding energy of the reference window.
  let er = 0;
  for (let i = 0; i < N; i++) er += ref[i] * ref[i];
  let best = -Infinity, bestLag = 0, bestScale = 0;
  for (let l = 0; l <= M - N; l++) {
    if (l > 0) { er += ref[l + N - 1] * ref[l + N - 1] - ref[l - 1] * ref[l - 1]; }
    if (er > 1e-9) {
      const c = cr[l] / size;
      const score = c / Math.sqrt(es * er);
      if (score > best) { best = score; bestLag = l; bestScale = c / er; }
    }
  }
  return { lag: bestLag, score: best === -Infinity ? 0 : best, scale: bestScale };
}
