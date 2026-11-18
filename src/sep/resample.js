// Windowed-sinc resampler (Kaiser window, 24 zero-crossings each side). Good enough for
// 48 kHz <-> 44.1 kHz round trips without audible aliasing; pure JS, no Web Audio needed (works in workers).
const HALF = 24;
const BETA = 8.6;

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 30; k++) { term *= (x / (2 * k)) ** 2; sum += term; }
  return sum;
}

const TABLE_RES = 512; // kernel samples per zero-crossing
const kernelCache = new Map();
function kernel(cutoff) {
  const key = cutoff.toFixed(6);
  if (kernelCache.has(key)) return kernelCache.get(key);
  const n = HALF * TABLE_RES;
  const k = new Float32Array(n + 2);
  const i0b = besselI0(BETA);
  for (let i = 0; i <= n + 1; i++) {
    const x = i / TABLE_RES; // distance in zero-crossings of the scaled sinc (= input samples × cutoff)
    const w = x >= HALF ? 0 : besselI0(BETA * Math.sqrt(1 - (x / HALF) ** 2)) / i0b;
    const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    k[i] = w * s * cutoff;
  }
  kernelCache.set(key, k);
  return k;
}

/** Resample `x` from rate `from` to rate `to`. Returns a new Float32Array. */
export function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.97; // a little below Nyquist of the lower rate
  const k = kernel(cutoff);
  const outLen = Math.floor(x.length * ratio);
  const y = new Float32Array(outLen);
  const step = 1 / ratio; // input samples per output sample
  const reach = Math.ceil(HALF / cutoff);
  for (let i = 0; i < outLen; i++) {
    const t = i * step;
    const c = Math.floor(t);
    let acc = 0;
    const a = Math.max(0, c - reach + 1), b = Math.min(x.length - 1, c + reach);
    for (let j = a; j <= b; j++) {
      const d = Math.abs(t - j) * cutoff * TABLE_RES;
      const di = d | 0;
      if (di >= HALF * TABLE_RES) continue;
      const f = d - di;
      acc += x[j] * (k[di] + (k[di + 1] - k[di]) * f);
    }
    y[i] = acc;
  }
  return y;
}
