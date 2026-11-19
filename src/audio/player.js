// Plays separated chunks in sync with the video, inside the AudioWorklet.
//
// The content script tells the player which audio frame corresponds to which media time (found by
// cross-correlating the live input with the decoded original). From then on, output frame f plays the
// separated sample for media time  media0 + (f − frame0) / sampleRate. Neighbouring chunks overlap a
// little and are crossfaded there, so chunk boundaries don't click.
export class ChunkPlayer {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.chunks = []; // { start (s), end (s), L, R } sorted by start
    this.map = null;  // { frame0, media0 }
    this.gain = 1;
  }

  addChunk(start, L, R) {
    const c = { start, end: start + L.length / this.sr, L, R };
    // Replace a chunk with the same start, or one the new chunk fully covers (separated again), so at
    // most two chunks ever overlap (the crossfade below handles exactly two).
    this.chunks = this.chunks.filter((x) => !(Math.abs(x.start - start) < 1e-6) && !(x.start >= start - 1e-6 && x.end <= c.end + 1e-6));
    this.chunks.push(c);
    this.chunks.sort((a, b) => a.start - b.start);
  }

  clearChunks() { this.chunks = []; }
  setMap(frame0, media0) { this.map = { frame0, media0 }; }
  clearMap() { this.map = null; }

  /** Media time (s) at an output frame, or null when not locked. */
  mediaAt(frame) { return this.map ? this.map.media0 + (frame - this.map.frame0) / this.sr : null; }

  /** Drop chunks that ended more than `keepSec` before media time `m`. */
  evictBefore(m, keepSec = 10) { this.chunks = this.chunks.filter((c) => c.end > m - keepSec); }

  /** Seconds of separated audio ready from media time m onward (contiguous). */
  readyAhead(m) {
    let t = m;
    for (const c of this.chunks) {
      if (c.start <= t + 1e-3 && c.end > t) t = c.end;
    }
    return Math.max(0, t - m);
  }

  /**
   * Render n frames starting at output frame `frame`. Returns true when every frame was covered
   * (the caller should use its fallback otherwise; outputs are then left untouched).
   */
  render(frame, n, outL, outR) {
    const m0 = this.mediaAt(frame);
    if (m0 === null) return false;
    const m1 = m0 + (n - 1) / this.sr;
    const cover = this.chunks.filter((c) => c.start <= m1 && c.end > m0);
    if (!cover.length) return false;
    // every frame must be inside some chunk
    for (const t of [m0, m1]) if (!cover.some((c) => c.start <= t && c.end > t)) return false;
    const g = this.gain;
    for (let i = 0; i < n; i++) {
      const m = m0 + i / this.sr;
      let a = null, b = null;
      for (const c of cover) {
        if (c.start <= m && c.end > m) { if (!a) a = c; else { b = c; break; } }
      }
      if (!a) return false;
      const ia = Math.floor((m - a.start) * this.sr);
      let l = a.L[ia], r = a.R[ia];
      if (b) {
        // overlap of a's tail with b's head: linear crossfade across it
        const ib = Math.floor((m - b.start) * this.sr);
        const w = (m - b.start) / (a.end - b.start);
        l = l * (1 - w) + b.L[ib] * w;
        r = r * (1 - w) + b.R[ib] * w;
      }
      outL[i] = l * g;
      if (outR) outR[i] = r * g;
    }
    return true;
  }
}
