// Streaming WebM demuxer for the Opus audio YouTube feeds into Media Source Extensions.
//
// YouTube appends the stream in arbitrary byte pieces (an element can be split across appends),
// so this parser keeps unconsumed bytes and resumes. It descends into the master elements it
// needs, reads the leaves it cares about, and skips everything else without buffering it.
// A new EBML header (quality switch, new MediaSource) starts a fresh stream.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};
const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);
const LEAVES = new Set([
  ID.EBML, ID.TimecodeScale, ID.TrackNumber, ID.TrackType, ID.CodecID, ID.CodecPrivate, ID.CodecDelay,
  ID.SamplingFrequency, ID.Channels, ID.Timecode, ID.SimpleBlock, ID.Block,
]);
const MAX_LEAF = 4 << 20; // a leaf bigger than this is not something we need: skip it

function readUint(b) { let v = 0; for (let i = 0; i < b.length; i++) v = v * 256 + b[i]; return v; }
function readFloat(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : b.length === 8 ? dv.getFloat64(0) : 0;
}

/** Duration of an Opus packet in microseconds, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketDurationUs(p) {
  if (!p || !p.length) return 0;
  const toc = p[0], config = toc >> 3, code = toc & 3;
  let frameUs;
  if (config < 12) frameUs = [10000, 20000, 40000, 60000][config & 3];        // SILK
  else if (config < 16) frameUs = [10000, 20000][config & 1];                 // Hybrid
  else frameUs = [2500, 5000, 10000, 20000][config & 3];                      // CELT
  const frames = code === 0 ? 1 : code === 1 || code === 2 ? 2 : p.length > 1 ? p[1] & 0x3f : 0;
  return frameUs * frames;
}

export class WebmOpusDemuxer {
  /**
   * @param {object} h
   * @param {(cfg: {codec:string, sampleRate:number, numberOfChannels:number, description:Uint8Array|null, codecDelayUs:number}) => void} h.onConfig
   * @param {(pkt: {timestampUs:number, durationUs:number, data:Uint8Array}) => void} h.onPacket
   * @param {(reason:string) => void} [h.onUnsupported]
   */
  constructor(h) {
    this.h = h;
    this.buf = new Uint8Array(0);
    this.skip = 0;
    this.resetStream();
  }

  resetStream() {
    this.timecodeScale = 1e6; // ns per tick (WebM default)
    this.clusterTc = 0;
    this.tracks = [];
    this.cur = null; // TrackEntry being read
    this.audioTrack = null;
    this.configured = false;
  }

  push(bytes) {
    let b = bytes;
    if (this.skip) {
      const n = Math.min(this.skip, b.length);
      this.skip -= n;
      b = b.subarray(n);
      if (!b.length) return;
    }
    if (this.buf.length) {
      const m = new Uint8Array(this.buf.length + b.length);
      m.set(this.buf); m.set(b, this.buf.length);
      b = m;
    }
    const used = this._parse(b);
    this.buf = used < b.length ? b.slice(used) : new Uint8Array(0);
  }

  _vint(b, pos, keepMarker) {
    if (pos >= b.length) return null;
    const first = b[pos];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8) return { bad: true };
    if (pos + len > b.length) return null;
    let v = keepMarker ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[pos + i]; if (b[pos + i] !== 0xff) allOnes = false; }
    return { value: v, len, unknown: !keepMarker && allOnes };
  }

  _parse(b) {
    let pos = 0;
    while (pos < b.length) {
      const id = this._vint(b, pos, true);
      if (!id) break;
      if (id.bad) { pos++; continue; } // resync: not a valid element start
      const size = this._vint(b, pos + id.len, false);
      if (!size) break;
      if (size.bad) { pos++; continue; }
      const head = id.len + size.len;
      const eid = id.value;

      if (MASTERS.has(eid) || (size.unknown && eid !== ID.EBML)) {
        if (eid === ID.Cluster) { this._finishTracks(); this.clusterTc = 0; }
        if (eid === ID.TrackEntry) { this.cur = { number: 0, type: 0, codec: '', priv: null, rate: 48000, channels: 2, delayNs: 0 }; this.tracks.push(this.cur); }
        pos += head;
        continue;
      }
      if (LEAVES.has(eid) && size.value <= MAX_LEAF) {
        if (pos + head + size.value > b.length) break; // wait for the rest
        this._leaf(eid, b.subarray(pos + head, pos + head + size.value));
        pos += head + size.value;
        continue;
      }
      // Anything else (SeekHead, Cues, Void, Tags…): skip without buffering.
      const total = head + size.value;
      if (pos + total <= b.length) { pos += total; continue; }
      this.skip = pos + total - b.length;
      return b.length;
    }
    return pos;
  }

  _leaf(eid, d) {
    switch (eid) {
      case ID.EBML: this.resetStream(); break;
      case ID.TimecodeScale: this.timecodeScale = readUint(d) || 1e6; break;
      case ID.TrackNumber: if (this.cur) this.cur.number = readUint(d); break;
      case ID.TrackType: if (this.cur) this.cur.type = readUint(d); break;
      case ID.CodecID: if (this.cur) this.cur.codec = new TextDecoder().decode(d).replace(/\0+$/, ''); break;
      case ID.CodecPrivate: if (this.cur) this.cur.priv = d.slice(); break;
      case ID.CodecDelay: if (this.cur) this.cur.delayNs = readUint(d); break;
      case ID.SamplingFrequency: if (this.cur) this.cur.rate = Math.round(readFloat(d)) || 48000; break;
      case ID.Channels: if (this.cur) this.cur.channels = readUint(d) || 2; break;
      case ID.Timecode: this.clusterTc = readUint(d); break;
      case ID.SimpleBlock:
      case ID.Block: this._block(d); break;
    }
  }

  _finishTracks() {
    if (this.configured) return;
    this.configured = true;
    this.audioTrack = this.tracks.find((t) => t.codec === 'A_OPUS') || null;
    if (!this.audioTrack) {
      const codecs = this.tracks.map((t) => t.codec).join(',') || 'none';
      this.h.onUnsupported?.(`no Opus track (found: ${codecs})`);
      return;
    }
    const t = this.audioTrack;
    this.h.onConfig?.({
      codec: 'opus', sampleRate: t.rate, numberOfChannels: t.channels,
      description: t.priv, codecDelayUs: t.delayNs / 1000,
    });
  }

  _block(d) {
    if (!this.audioTrack) return;
    const tn = this._vint(d, 0, false);
    if (!tn || tn.bad || tn.value !== this.audioTrack.number) return;
    let p = tn.len;
    const rel = (d[p] << 24 >> 16) | d[p + 1]; // signed int16
    p += 2;
    const flags = d[p++];
    const lacing = (flags >> 1) & 3;
    const baseUs = ((this.clusterTc + rel) * this.timecodeScale) / 1000;
    const frames = lacing === 0 ? [d.subarray(p)] : this._unlace(d, p, lacing);
    let t = baseUs;
    for (const f of frames) {
      const dur = opusPacketDurationUs(f);
      this.h.onPacket({ timestampUs: t, durationUs: dur, data: f });
      t += dur;
    }
  }

  _unlace(d, p, lacing) {
    const count = d[p++] + 1;
    const sizes = [];
    if (lacing === 1) { // Xiph
      for (let i = 0; i < count - 1; i++) { let s = 0, v; do { v = d[p++]; s += v; } while (v === 255); sizes.push(s); }
    } else if (lacing === 3) { // EBML
      const first = this._vint(d, p, false); p += first.len; sizes.push(first.value);
      for (let i = 1; i < count - 1; i++) {
        const v = this._vint(d, p, false); p += v.len;
        const bias = 2 ** (7 * v.len - 1) - 1;
        sizes.push(sizes[i - 1] + (v.value - bias));
      }
    } else { // fixed
      const each = Math.floor((d.length - p) / count);
      for (let i = 0; i < count - 1; i++) sizes.push(each);
    }
    const out = [];
    for (const s of sizes) { out.push(d.subarray(p, p + s)); p += s; }
    out.push(d.subarray(p));
    return out;
  }
}
