// Decoded stereo PCM stored by media time, in 1-second slots, with 10 ms coverage cells.
export class PcmTimeline {
  constructor(sampleRate = 48000) {
    this.sr = sampleRate;
    this.cell = Math.round(sampleRate / 100);
    this.slots = new Map(); // second -> { L, R, cells: Uint8Array(100) }
  }

  clear() { this.slots.clear(); }

  _slot(sec, create) {
    let s = this.slots.get(sec);
    if (!s && create) {
      s = { L: new Float32Array(this.sr), R: new Float32Array(this.sr), cells: new Uint8Array(100) };
      this.slots.set(sec, s);
    }
    return s;
  }

  /** Write planes starting at absolute sample index `start` (may be negative: those samples are dropped). */
  write(start, left, right) {
    const n = left.length;
    let i = 0;
    while (i < n) {
      const abs = start + i;
      if (abs < 0) { i = Math.min(n, -start); continue; }
      const sec = Math.floor(abs / this.sr);
      const off = abs - sec * this.sr;
      const take = Math.min(n - i, this.sr - off);
      const s = this._slot(sec, true);
      s.L.set(left.subarray(i, i + take), off);
      s.R.set((right || left).subarray(i, i + take), off);
      const c0 = Math.floor(off / this.cell), c1 = Math.floor((off + take - 1) / this.cell);
      for (let c = c0; c <= c1; c++) s.cells[c] = 1;
      i += take;
    }
  }

  /** Fraction (0..1) of 10 ms cells between t0 and t1 seconds that hold audio. */
  coverage(t0, t1) {
    const a = Math.max(0, Math.floor(t0 * 100)), b = Math.ceil(t1 * 100);
    if (b <= a) return 1;
    let have = 0;
    for (let c = a; c < b; c++) {
      const s = this.slots.get(Math.floor(c / 100));
      if (s && s.cells[c % 100]) have++;
    }
    return have / (b - a);
  }

  /** Last second (exclusive) that holds any audio, or 0. */
  end() {
    let m = 0;
    for (const k of this.slots.keys()) if (k + 1 > m) m = k + 1;
    return m;
  }

  /** Stereo copy of [t0, t1) seconds; missing audio (or t < 0) is silence. */
  read(t0, t1) {
    const a = Math.round(t0 * this.sr), n = Math.max(0, Math.round(t1 * this.sr) - a);
    const L = new Float32Array(n), R = new Float32Array(n);
    let i = 0;
    while (i < n) {
      const abs = a + i;
      if (abs < 0) { i = Math.min(n, -a); continue; }
      const sec = Math.floor(abs / this.sr), off = abs - sec * this.sr;
      const take = Math.min(n - i, this.sr - off);
      const s = this.slots.get(sec);
      if (s) { L.set(s.L.subarray(off, off + take), i); R.set(s.R.subarray(off, off + take), i); }
      i += take;
    }
    return { L, R };
  }

  /** Drop slots outside [from, to) seconds. */
  evict(from, to) {
    for (const k of [...this.slots.keys()]) if (k + 1 < from || k > to) this.slots.delete(k);
  }
}
