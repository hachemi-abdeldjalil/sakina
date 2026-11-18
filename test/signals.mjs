// Synthetic test material at a given sample rate (mono Float32Array).
export const SR = 48000;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Chords held for `chordSec` each, with 6 harmonics per note.
export function chords(sec, chordSec = 1.2, sr = SR) {
  const prog = [
    [110, 220, 277.18, 329.63],
    [98, 196, 246.94, 293.66],
    [130.81, 261.63, 329.63, 392],
    [87.31, 174.61, 220, 261.63],
  ];
  const out = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const notes = prog[Math.floor(t / chordSec) % prog.length];
    let v = 0;
    for (const f of notes) for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h);
    out[i] = 0.08 * v;
  }
  return out;
}

// A melody of short plucked notes (harder case: each note lasts `noteSec`).
export function melody(sec, noteSec = 0.25, sr = SR) {
  const scale = [440, 493.88, 523.25, 587.33, 659.25, 587.33, 523.25, 493.88];
  const out = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const n = Math.floor(t / noteSec);
    const f = scale[n % scale.length];
    const local = t - n * noteSec;
    const env = Math.exp(-local * 4);
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    out[i] = 0.12 * env * v;
  }
  return out;
}

// Speech-like syllables: gliding pitch, formant-shaped harmonics, gaps between.
export function speech(sec, sr = SR, seed = 7) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(sec * sr));
  let t0 = 0;
  while (t0 < sec) {
    const dur = 0.12 + r() * 0.12;
    const f0a = 100 + r() * 120;
    const f0b = f0a * (0.75 + r() * 0.5);
    const formants = [400 + r() * 600, 1000 + r() * 1400, 2400 + r() * 600];
    const start = Math.round(t0 * sr), len = Math.round(dur * sr);
    let phase = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const u = i / len;
      const f0 = f0a + (f0b - f0a) * u;
      phase += (2 * Math.PI * f0) / sr;
      const env = Math.sin(Math.PI * u) ** 0.7;
      let v = 0;
      for (let h = 1; h * f0 < 4000; h++) {
        const fh = h * f0;
        let amp = 0;
        for (const fm of formants) amp += Math.exp(-(((fh - fm) / 180) ** 2));
        v += amp * Math.sin(h * phase);
      }
      out[start + i] += 0.05 * env * v;
    }
    t0 += dur + 0.04 + r() * 0.08;
  }
  return out;
}

// Effects: short decaying noise hits every 0.4 s and a low rumble in the middle.
export function effects(sec, sr = SR, seed = 3) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(sec * sr));
  for (let t0 = 0.1; t0 < sec; t0 += 0.4) {
    const start = Math.round(t0 * sr);
    for (let i = 0; i < 0.06 * sr && start + i < out.length; i++) {
      out[start + i] += 0.4 * (r() * 2 - 1) * Math.exp(-i / (0.012 * sr));
    }
  }
  let lp = 0;
  const a = Math.round(sec * 0.4 * sr), b = Math.round(sec * 0.6 * sr);
  for (let i = a; i < b; i++) {
    lp += 0.02 * ((r() * 2 - 1) - lp);
    out[i] += 1.5 * lp;
  }
  return out;
}

export function add(...xs) {
  const out = new Float32Array(xs[0].length);
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i] += x[i];
  return out;
}
