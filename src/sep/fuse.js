// Merge the model's "no music" output with RNNoise voice protection, offline, at 48 kHz.
//
// The separation model (MRX) treats melodic recitation and unaccompanied singing as music. RNNoise
// recognises them as voice. Per STFT bin: gain = max(modelShare, gate · voiceShare), where
//   modelShare = |S| / |X|   (S = the model's music-free output, X = the original),
//   voiceShare = |V| / |X|   (V = RNNoise's voice estimate),
//   gate       = how sure RNNoise is that someone is speaking/reciting (smoothed VAD, 0..1).
// The output is iSTFT(gain · X): only ever a gain ≤ 1 on the original, so nothing new is invented.
import { FFT } from '../dsp/fft.js';
import { RNNOISE_FRAME, RNNOISE_DELAY } from '../dsp/rnnoise-voice.js';

const N = 2048, HOP = 512;
const fft = new FFT(N);
const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/**
 * Run RNNoise over a whole mono buffer (48 kHz). Returns { voice: Float32Array (aligned to the input),
 * vad: Float32Array (one value per 480-sample frame, smoothed) }.
 */
export function rnnoiseOffline(mono, voiceModel) {
  const F = RNNOISE_FRAME;
  const frames = Math.ceil(mono.length / F) + Math.ceil(RNNOISE_DELAY / F) + 1;
  const raw = new Float32Array(frames * F);
  const vad = new Float32Array(frames);
  const inp = new Float32Array(F), out = new Float32Array(F);
  let smooth = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < F; i++) inp[i] = (mono[f * F + i] ?? 0) * 32768;
    const v = voiceModel.process(inp, out);
    smooth = 0.8 * smooth + 0.2 * v;
    vad[f] = smooth;
    raw.set(out, f * F);
  }
  // RNNoise's output lags its input by RNNOISE_DELAY samples within the frame stream.
  const voice = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) voice[i] = (raw[i + RNNOISE_DELAY] ?? 0) / 32768;
  // VAD is reported once the frame has been seen: shift it back by the same delay.
  const shift = Math.round(RNNOISE_DELAY / F);
  const vadAligned = new Float32Array(Math.ceil(mono.length / F));
  for (let f = 0; f < vadAligned.length; f++) vadAligned[f] = vad[Math.min(vad.length - 1, f + shift)];
  return { voice, vad: vadAligned };
}

/**
 * @param {Float32Array} L, R        original (48 kHz)
 * @param {Float32Array} sL, sR      model output without music, same length and alignment
 * @param {Float32Array} voice       RNNoise voice estimate (mono), same alignment
 * @param {Float32Array} vad         smoothed voice probability per 480-sample frame
 * @param {object} opts              { protect: 0..1, vadLo, vadHi, floor, dominance: [lo, hi] | null }
 */
export function fuseVoice(L, R, sL, sR, voice, vad, opts = {}) {
  const protect = opts.protect ?? 1;
  const vadLo = opts.vadLo ?? 0.8, vadHi = opts.vadHi ?? 0.97;
  const floor = opts.floor ?? 0;
  const len = L.length, pad = N / 2;
  const dom = voiceDominance(L, R, voice, opts.dominance);
  const T = Math.floor(len / HOP) + 1;
  const outL = new Float64Array(len + N), outR = new Float64Array(len + N), wsum = new Float64Array(len + N);
  const xr = new Float64Array(N), xi = new Float64Array(N);
  const sr = new Float64Array(N), si = new Float64Array(N);
  const vr = new Float64Array(N), vi = new Float64Array(N);
  const at = (a, j) => (j >= 0 && j < a.length ? a[j] : 0);
  // "Rock-steady pitch" exception: a bin whose frequency has not moved for ~120 ms is an instrument,
  // even when RNNoise calls it voice (it does, for clean synthetic or organ-like tones).
  const bins = N / 2 + 1;
  const prevPh = new Float64Array(bins), prevDev = new Float64Array(bins), stable = new Uint16Array(bins);
  const rockFrames = opts.rockFrames ?? 11, rockKeep = opts.rockKeep ?? 0.3, rockTol = 0.12;
  const wrap = (x) => { x = (x + Math.PI) % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x - Math.PI; };
  for (let t = 0; t < T; t++) {
    const start = t * HOP - pad;
    for (let i = 0; i < N; i++) {
      const j = start + i, w = win[i];
      xr[i] = at(L, j) * w; xi[i] = at(R, j) * w;
      sr[i] = at(sL, j) * w; si[i] = at(sR, j) * w;
      vr[i] = at(voice, j) * w; vi[i] = 0;
    }
    fft.transform(xr, xi); fft.transform(sr, si); fft.transform(vr, vi);
    const centre = Math.min(vad.length - 1, Math.max(0, Math.floor((start + pad) / RNNOISE_FRAME)));
    let gate = (vad[centre] - vadLo) / (vadHi - vadLo);
    gate = (gate < 0 ? 0 : gate > 1 ? 1 : gate) * protect;
    if (dom) gate *= dom[centre];
    for (let k = 0; k <= N / 2; k++) {
      const j = (N - k) % N;
      // stereo magnitudes from the packed spectra (|XL|²+|XR|² = (|Z[k]|²+|Z[j]|²)/2)
      const xm = Math.sqrt(0.5 * (xr[k] * xr[k] + xi[k] * xi[k] + xr[j] * xr[j] + xi[j] * xi[j])) + 1e-9;
      const sm = Math.sqrt(0.5 * (sr[k] * sr[k] + si[k] * si[k] + sr[j] * sr[j] + si[j] * si[j]));
      // xm and sm are sqrt(|XL|²+|XR|²) = √2·|mid| for a centred source; the voice estimate is mid-based.
      const vm = Math.sqrt(vr[k] * vr[k] + vi[k] * vi[k]) * Math.SQRT2;
      // phase-vocoder frequency drift of the mid signal in this bin
      const mr = 0.25 * (xr[k] + xr[j] + xi[k] + xi[j]), mi = 0.25 * (xi[k] - xi[j] - xr[k] + xr[j]);
      const ph = Math.atan2(mi, mr);
      const dev = wrap(ph - prevPh[k] - (2 * Math.PI * k * HOP) / N);
      stable[k] = Math.abs(wrap(dev - prevDev[k])) < rockTol && xm > 1e-6 ? Math.min(65535, stable[k] + 1) : 0;
      prevPh[k] = ph; prevDev[k] = dev;
      let g = sm / xm;
      if (gate > 0) {
        let keep = gate * (vm / xm);
        if (stable[k] >= rockFrames) keep *= rockKeep;
        if (keep > g) g = keep;
      }
      if (g > 1) g = 1;
      if (g < floor) g = floor;
      xr[k] *= g; xi[k] *= g;
      if (j !== k) { xr[j] *= g; xi[j] *= g; }
    }
    fft.transform(xr, xi, true);
    for (let i = 0; i < N; i++) {
      const p = t * HOP + i, w = win[i];
      outL[p] += (xr[i] / N) * w; outR[p] += (xi[i] / N) * w; wsum[p] += w * w;
    }
  }
  const yL = new Float32Array(len), yR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const w = wsum[i + pad];
    if (w > 1e-8) { yL[i] = outL[i + pad] / w; yR[i] = outR[i + pad] / w; }
  }
  return { L: yL, R: yR };
}

/**
 * How much of the sound is the voice, per 480-sample frame, over a sliding 0.8 s window: the share of the
 * mid signal's energy that RNNoise keeps as voice, mapped from [lo, hi] to 0..1. A voice on its own
 * (recitation, speech) explains almost all of it (0.85-1). A singer over instruments, or music RNNoise
 * mistakes for a voice, leaves the instruments over (mostly under 0.6). [0.5, 0.75] was tuned on real
 * clips: music 72→95 % removed (vlog), recitation's worst seconds +2 to +11 points. Protection is scaled by this, so
 * it keeps recitation without putting the music back. Returns null when disabled.
 */
export function voiceDominance(L, R, voice, range = [0.5, 0.75]) {
  if (!range) return null;
  const [lo, hi] = range;
  const F = RNNOISE_FRAME, n = Math.ceil(L.length / F), W = 40;
  const em = new Float64Array(n), ev = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let a = 0, b = 0;
    for (let i = f * F, e = Math.min(L.length, i + F); i < e; i++) {
      const m = 0.5 * (L[i] + R[i]);
      a += m * m; b += voice[i] * voice[i];
    }
    em[f] = a; ev[f] = b;
  }
  const out = new Float32Array(n);
  let sa = 0, sb = 0;
  for (let f = 0; f < Math.min(n, W); f++) { sa += em[f]; sb += ev[f]; }
  for (let f = 0; f < n; f++) {
    if (f + W < n) { sa += em[f + W]; sb += ev[f + W]; }
    if (f - W - 1 >= 0) { sa -= em[f - W - 1]; sb -= ev[f - W - 1]; }
    const share = sa > 1e-9 ? Math.min(1, sb / sa) : 1;
    const d = (share - lo) / (hi - lo);
    out[f] = d < 0 ? 0 : d > 1 ? 1 : d;
  }
  return out;
}

