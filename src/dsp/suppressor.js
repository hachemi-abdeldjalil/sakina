import { FFT } from './fft.js';

// Real-time music suppressor.
//
// Idea: musical notes are *sustained tonal peaks* — energy that sits on the
// same frequency for a long time. Speech harmonics glide and stop every
// syllable, and most sound effects (hits, steps, doors, explosions) are short
// or broadband. So for every frequency bin we track a running percentile of
// its recent magnitude (the "sustained" part), keep only the part of it that
// stands out as a spectral peak (tonal), and subtract that. Optional "voice
// focus" also turns down the stereo side channel, where music is often mixed.
//
// Voice protection (optional): a held, melodic voice — Quran recitation, a
// nasheed, a long vowel — looks exactly like a held note to the rules above.
// When a voice model is supplied (RNNoise, see rnnoise-voice.js), it runs in
// parallel; while it is confident someone is speaking or reciting, every bin
// keeps at least the share of its energy that the model attributes to voice.
//
// Latency is one FFT frame (2048 samples ≈ 43 ms at 48 kHz), plus 30 ms with
// voice protection.
export class MusicSuppressor {
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.N = opts.fftSize ?? (sampleRate > 50000 ? 4096 : 2048);
    this.hop = this.N / 4;
    this.bins = this.N / 2 + 1;
    const frameSec = this.hop / sampleRate;
    this.K = Math.max(8, Math.round((opts.memorySec ?? 0.45) / frameSec));
    this.fft = new FFT(this.N);

    this.win = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
    this.olaNorm = 1 / 1.5; // periodic Hann: Σ hann² at 75% overlap = 1.5

    this.inL = new Float64Array(this.N);
    this.inR = new Float64Array(this.N);
    this.ola = [new Float64Array(this.N), new Float64Array(this.N)];
    this.outQ = [new Float64Array(this.hop), new Float64Array(this.hop)];
    this.pos = 0;

    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.mag = new Float64Array(this.bins);
    this.hist = Array.from({ length: this.K }, () => new Float32Array(this.bins));
    this.histCount = 0;
    this.histIdx = 0;
    this.tmp = new Float64Array(this.K);
    this.sus = new Float64Array(this.bins);
    this.phase = new Float64Array(this.bins);
    this.prevPhase = new Float64Array(this.bins);
    this.prevDev = new Float64Array(this.bins);
    this.stable = new Float64Array(this.bins);
    this.gain = new Float64Array(this.bins);
    this.gainPrev = new Float64Array(this.bins).fill(1);
    this.lastReduction = 0;

    this.voice = opts.voice || null;
    if (this.voice) {
      const F = this.voice.frameSize;
      this.vIn = new Float32Array(F);
      this.vOut = new Float32Array(F);
      this.vPos = 0;
      this.vad = 0;
      // Delay the main path so it lines up with the voice estimate.
      this.delay = F + this.voice.delay;
      this.dSize = this.delay + 1;
      this.dL = new Float64Array(this.dSize);
      this.dR = new Float64Array(this.dSize);
      this.dIdx = 0;
      this.inV = new Float64Array(this.N);
      this.reV = new Float64Array(this.N);
      this.imV = new Float64Array(this.N);
      this.voiceMag = new Float64Array(this.bins);
      this.midMag = new Float64Array(this.bins);
      this.vadLo = opts.vadLo ?? 0.8;
      // Voice dominance (see voiceDominance in sep/fuse.js): smoothed energy of the voice estimate vs the mid
      // signal. Protection only applies while the voice is most of the sound, so music RNNoise mistakes for
      // a voice (or a singer over instruments) is not put back. null disables it.
      this.dominance = opts.dominance === undefined ? [0.5, 0.75] : opts.dominance;
      this.domV = 0; this.domM = 0; this.domShare = 1;
      this.vadHi = opts.vadHi ?? 0.97;
      this.shareExp = opts.shareExp ?? 1;
      this.rockFrames = opts.rockFrames ?? 6;
      this.rockKeep = opts.rockKeep ?? 0.3;
    } else {
      this.delay = 0;
    }

    this.setParams({ strength: 0.8, voiceFocus: 0.4, voiceProtect: 1, keepSfx: true, ...opts });
  }

  // strength 0..1 (0 = untouched). voiceFocus 0..1 turns down stereo sides.
  // keepSfx false = voices only: with a voice model, anything it does not hear as voice is cut too.
  setParams({ strength, voiceFocus, voiceProtect, keepSfx } = {}) {
    if (keepSfx !== undefined) this.keepSfx = keepSfx !== false;
    if (voiceProtect !== undefined) this.voiceProtect = Math.min(1, Math.max(0, voiceProtect));
    if (strength !== undefined) this.strength = Math.min(1, Math.max(0, strength));
    if (voiceFocus !== undefined) this.voiceFocus = Math.min(1, Math.max(0, voiceFocus));
    const st = this.strength;
    this.beta = st * 2.4;                         // over-subtraction of the sustained part
    this.floor = Math.pow(10, -(6 + 30 * st) / 20); // deepest cut per bin
    this.pct = 0.5 + 0.15 * st;                   // percentile = how long a tone must last
    this.tonalLo = 2.2 - 0.6 * st;  // peak/valley ratio where removal starts
    this.tonalHi = 6 - 2 * st;      // ...and where it is full
    this.sideGain = 1 - 0.85 * this.voiceFocus;
    // Fast lane: a bin whose frequency holds still for this many frames is a held note.
    this.stableFrames = Math.round(7 - 2 * st);
    this.stableTol = 0.08 + 0.04 * st;            // rad/hop of allowed frequency drift
    this.fastDepth = 0.95 * st;
  }

  get latency() { return this.N + this.delay; }

  // Process one block. Inputs/outputs are Float32Array (or any array) of equal length.
  process(inL, inR, outL, outR) {
    const { N, hop } = this;
    const base = N - hop;
    const sg = this.sideGain;
    for (let i = 0; i < inL.length; i++) {
      let l = inL[i], r = inR ? inR[i] : l;
      if (this.voice) {
        // Voice model runs on the mid signal in 480-sample frames.
        this.inV[base + this.pos] = this.vOut[this.vPos] / 32768;
        this.vIn[this.vPos] = 0.5 * (l + r) * 32768;
        if (++this.vPos === this.vIn.length) {
          const v = this.voice.process(this.vIn, this.vOut);
          this.vad = 0.8 * this.vad + 0.2 * v;
          this.vPos = 0;
        }
        // Main path delayed by the same amount.
        this.dL[this.dIdx] = l; this.dR[this.dIdx] = r;
        const rd = (this.dIdx + 1) % this.dSize; // oldest sample = `delay` samples ago
        l = this.dL[rd]; r = this.dR[rd];
        this.dIdx = rd;
      }
      const m = 0.5 * (l + r), sd = 0.5 * (l - r) * sg;
      this.inL[base + this.pos] = m + sd;
      this.inR[base + this.pos] = m - sd;
      outL[i] = this.outQ[0][this.pos];
      if (outR) outR[i] = this.outQ[1][this.pos];
      if (++this.pos === hop) {
        this._frame();
        this.pos = 0;
      }
    }
  }

  _frame() {
    const { N, hop, bins, re, im, win, mag } = this;
    for (let t = 0; t < N; t++) {
      re[t] = this.inL[t] * win[t];
      im[t] = this.inR[t] * win[t];
    }
    this.fft.transform(re, im, false);

    // Per-bin stereo magnitude: |XL|²+|XR|² = (|Z[k]|²+|Z[N-k]|²)/2 for Z = FFT(L + iR).
    for (let k = 0; k < bins; k++) {
      const j = (N - k) % N;
      mag[k] = Math.sqrt(0.5 * (re[k] * re[k] + im[k] * im[k] + re[j] * re[j] + im[j] * im[j]));
      // Mid (L+R) spectrum: XL = (Z[k]+conj Z[j])/2, XR = (Z[k]-conj Z[j])/2i
      const mr = 0.5 * (re[k] + re[j]) + 0.5 * (im[k] + im[j]);
      const mi = 0.5 * (im[k] - im[j]) - 0.5 * (re[k] - re[j]);
      this.phase[k] = Math.atan2(mi, mr);
      if (this.voice) this.midMag[k] = 0.5 * Math.sqrt(mr * mr + mi * mi);
    }

    if (this.voice) {
      const { reV, imV, inV } = this;
      for (let t = 0; t < N; t++) { reV[t] = inV[t] * win[t]; imV[t] = 0; }
      this.fft.transform(reV, imV, false);
      let ev = 0, em = 0;
      for (let k = 0; k < bins; k++) {
        this.voiceMag[k] = Math.sqrt(reV[k] * reV[k] + imV[k] * imV[k]);
        ev += this.voiceMag[k] * this.voiceMag[k]; em += this.midMag[k] * this.midMag[k];
      }
      // ~0.4 s exponential window (hop 512 at 48 kHz = 10.7 ms)
      this.domV += (ev - this.domV) / 40; this.domM += (em - this.domM) / 40;
      this.domShare = this.domM > 1e-9 ? Math.min(1, this.domV / this.domM) : 1;
      inV.copyWithin(0, hop);
    }

    if (this.beta > 0) {
      this._computeGains();
      const g = this.gain;
      for (let k = 0; k < bins; k++) {
        const j = (N - k) % N;
        re[k] *= g[k]; im[k] *= g[k];
        if (j !== k) { re[j] *= g[k]; im[j] *= g[k]; }
      }
    } else {
      this.lastReduction = 0;
    }

    this.fft.transform(re, im, true);
    const scale = this.olaNorm / N;
    const [oL, oR] = this.ola;
    for (let t = 0; t < N; t++) {
      oL[t] += re[t] * win[t] * scale;
      oR[t] += im[t] * win[t] * scale;
    }
    for (let ch = 0; ch < 2; ch++) {
      const o = this.ola[ch];
      this.outQ[ch].set(o.subarray(0, hop));
      o.copyWithin(0, hop);
      o.fill(0, N - hop);
    }
    this.inL.copyWithin(0, hop);
    this.inR.copyWithin(0, hop);
  }

  _computeGains() {
    const { bins, mag, hist, K, tmp, sus, gain, gainPrev } = this;
    hist[this.histIdx].set(mag);
    this.histIdx = (this.histIdx + 1) % K;
    if (this.histCount < K) this.histCount++;
    const n = this.histCount;
    const kth = Math.min(n - 1, Math.floor(this.pct * n));

    // Sustained magnitude per bin = running percentile over the last ~0.45 s.
    for (let k = 0; k < bins; k++) {
      for (let h = 0; h < n; h++) tmp[h] = hist[h][k];
      sus[k] = quickselect(tmp, n, kth);
    }

    // Tonality: how far the sustained spectrum rises above its nearby valley
    // (minimum within ±W bins). Notes are sharp peaks; steady noise (rain,
    // engines, crowd) is flat and is left alone.
    const W = 3;
    const { beta, floor, tonalLo, tonalHi } = this;
    let inE = 0, outE = 0;
    for (let k = 0; k < bins; k++) {
      let lo = Infinity;
      const a = Math.max(0, k - W), b = Math.min(bins - 1, k + W);
      for (let q = a; q <= b; q++) if (sus[q] < lo) lo = sus[q];
      const ratio = sus[k] / (lo + 1e-9);
      let tonal = (ratio - tonalLo) / (tonalHi - tonalLo);
      tonal = tonal < 0 ? 0 : tonal > 1 ? 1 : tonal;
      const m = mag[k] + 1e-12;
      let g = 1 - (beta * sus[k] * tonal) / m;

      // Fast lane: phase-vocoder frequency estimate; steady over several frames => note.
      const dev = wrapPi(this.phase[k] - this.prevPhase[k] - (2 * Math.PI * k * this.hop) / this.N);
      const drift = Math.abs(wrapPi(dev - this.prevDev[k]));
      this.prevDev[k] = dev;
      this.prevPhase[k] = this.phase[k];
      this.stable[k] = drift < this.stableTol && m > 1e-5 ? this.stable[k] + 1 : 0;
      const over = this.stable[k] - this.stableFrames;
      if (over >= 0) {
        const w = over >= 2 ? 1 : (over + 1) / 3;
        const gFast = 1 - this.fastDepth * w;
        if (gFast < g) g = gFast;
      }

      if (g < floor) g = floor;
      gain[k] = g;
    }

    // Voice protection: keep at least the voice share of each bin while voice is likely.
    if (this.voice && this.voiceProtect > 0) {
      let gate = (this.vad - this.vadLo) / (this.vadHi - this.vadLo);
      gate = gate < 0 ? 0 : gate > 1 ? 1 : gate;
      gate *= this.voiceProtect;
      if (this.dominance) {
        const [lo, hi] = this.dominance;
        const d = (this.domShare - lo) / (hi - lo);
        gate *= d < 0 ? 0 : d > 1 ? 1 : d;
      }
      if (gate > 0) {
        for (let k = 0; k < bins; k++) {
          let share = this.voiceMag[k] / (this.midMag[k] + 1e-9);
          if (share > 1) share = 1;
          if (this.shareExp !== 1) share = Math.pow(share, this.shareExp);
          let keep = gate * share;
          // A pitch that has not moved at all for a long stretch is an instrument, not a voice.
          if (this.stable[k] >= this.stableFrames + this.rockFrames) keep *= this.rockKeep;
          if (keep > gain[k]) gain[k] = keep;
        }
      }
    }
    // Voices only (sound effects removed too): cap each bin at the voice model's share of it, faded in
    // by its voice probability, so effects, ambience and pauses between words go quiet. The square root
    // is gentler on reverberant voices (on real clips: a talk loses 31 % instead of 40 %), while a bin
    // with almost no voice in it still drops to the floor.
    if (this.voice && !this.keepSfx) {
      let vg = (this.vad - 0.3) / 0.4;
      vg = vg < 0 ? 0 : vg > 1 ? 1 : vg;
      for (let k = 0; k < bins; k++) {
        let share = this.voiceMag[k] / (this.midMag[k] + 1e-9);
        if (share > 1) share = 1;
        const cap = vg * Math.sqrt(share);
        if (cap < gain[k]) gain[k] = cap;
      }
    }
    // Smooth across frequency (3 taps) and time to avoid "musical noise".
    let prev = gain[0];
    for (let k = 0; k < bins; k++) {
      const next = k + 1 < bins ? gain[k + 1] : gain[k];
      const cur = gain[k];
      let g = 0.25 * prev + 0.5 * cur + 0.25 * next;
      prev = cur;
      g = 0.6 * g + 0.4 * gainPrev[k];
      if (g < floor) g = floor;
      gainPrev[k] = g;
      inE += mag[k] * mag[k];
      outE += mag[k] * mag[k] * g * g;
    }
    gain.set(gainPrev);
    this.lastReduction = inE > 1e-9 ? 1 - outE / inE : 0; // share of energy removed this frame
  }
}

function wrapPi(x) {
  x = (x + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

// k-th smallest of a[0..n) (partially reorders a).
function quickselect(a, n, k) {
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}
