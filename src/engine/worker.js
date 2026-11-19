// Sakina v2 separation worker (module worker, extension origin, inside a hidden iframe on YouTube).
//
//   captured WebM/Opus bytes → demux → WebCodecs AudioDecoder → 48 kHz timeline
//   → chunks of up to 10 s (+1 s context each side), the first gap after the playhead first
//   → MRX (music / speech / sfx) + RNNoise voice protection → separated chunk → content script
//
// It also answers "align" requests: where in the decoded original does this live snippet sit?
import * as ort from 'onnxruntime-web/wasm';
import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';
import { WebmOpusDemuxer } from '../sep/webm.js';
import { PcmTimeline } from '../sep/timeline.js';
import { alignSnippet } from '../sep/align.js';
import { separateBlock } from '../sep/job.js';
import { createRnnoiseVoice } from '../dsp/rnnoise-voice.js';

const SR = 48000;
const CHUNK = 10;      // seconds of output per job
const SHORT = 5;       // seconds per job while the AI track is catching up with the playhead
const MIN_JOB = 1.5;   // shortest job worth running (except right before the end or the next chunk)
const CTX = 1;         // seconds of context on each side (the model looks both ways)
const OVERLAP = 0.05;  // seconds shared with the neighbour chunk, crossfaded by the player
const LOOKAHEAD = 75;  // seconds ahead of the playhead worth separating
const BEHIND = 60;     // seconds behind the playhead worth keeping

let port = null;
let ready = false;
let session = null, rnn = null;
const timeline = new PcmTimeline(SR);
let demuxer = null, decoder = null, streamId = 0;
let decoderChannels = 2;
const state = { playhead: 0, duration: Infinity, playing: false, rate: 1, enabled: true };
let settings = { protect: 1.3, sfx: 1 }; // sfx: weight of the sound-effects layer (1 keep, 0 remove)
const spans = [];        // separated stretches [start, end] (s) the player has or will get, sorted by start
let busy = false;
let speed = 0;           // seconds of audio separated per second of work (moving average)
let lastShare = null;
let lastRemoved = null;  // energy removed from the last separated chunk (diagnostics)
let generation = 0;      // bumped on reset/settings change, so stale jobs are discarded

const send = (msg, transfer) => port && port.postMessage(msg, transfer || []);
const fail = (where, err) => send({ type: 'error', error: `${where}: ${err?.message || err}` });

self.onmessage = (e) => {
  if (e.data?.type !== 'port' || port) return;
  port = e.ports[0];
  port.onmessage = (m) => { try { onMessage(m.data); } catch (err) { fail('message', err); } };
  init().catch((err) => fail('init', err));
};

async function init() {
  const base = new URL('./', import.meta.url);
  ort.env.wasm.wasmPaths = new URL('ort/', base).href;
  ort.env.wasm.numThreads = 1; // the iframe is not cross-origin isolated, so no threads
  ort.env.wasm.proxy = false;
  const t0 = performance.now();
  session = await ort.InferenceSession.create(new URL('../models/mrx.int8.onnx', base).href, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  const wasm = await (await fetch(new URL('rnnoise.wasm', base))).arrayBuffer();
  rnn = await createRNNWasmModule({ wasmBinary: wasm });
  ready = true;
  send({ type: 'ready', loadMs: Math.round(performance.now() - t0) });
  schedule();
}

function run(feeds) {
  const f = {};
  for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor('float32', v.data, v.dims);
  return session.run(f);
}

function onMessage(msg) {
  switch (msg.type) {
    case 'new': startStream(msg.id); break;
    case 'append':
      if (msg.id !== streamId) startStream(msg.id);
      demuxer.push(msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes));
      break;
    case 'playhead':
      Object.assign(state, { playhead: msg.t, duration: msg.duration || Infinity, playing: msg.playing, rate: msg.rate, enabled: msg.enabled !== false });
      break;
    case 'have': // the player's current chunks (after a seek or a reload of the player)
      spans.length = 0;
      for (const [s, e] of msg.spans || []) spans.push([s > 0.01 ? s + OVERLAP : 0, e - OVERLAP]);
      spans.sort((x, y) => x[0] - y[0]);
      break;
    case 'settings': {
      const next = { ...settings };
      if (msg.protect !== undefined) next.protect = msg.protect;
      if (msg.sfx !== undefined) next.sfx = msg.sfx;
      if (next.protect !== settings.protect || next.sfx !== settings.sfx) {
        settings = next; // chunks made with the old settings are thrown away and made again
        generation++;
        spans.length = 0;
        send({ type: 'cleared' });
      }
      break;
    }
    case 'align': handleAlign(msg); break;
  }
  schedule();
}

function startStream(id) {
  streamId = id;
  generation++;
  timeline.clear();
  spans.length = 0;
  try { decoder?.close(); } catch {}
  decoder = null;
  demuxer = new WebmOpusDemuxer({
    onConfig: configureDecoder,
    onPacket: (p) => {
      if (!decoder || decoder.state !== 'configured') return;
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timestampUs, duration: p.durationUs, data: p.data }));
    },
    onUnsupported: (r) => send({ type: 'unsupported', reason: r }),
  });
  send({ type: 'cleared' });
}

function configureDecoder(cfg) {
  try { decoder?.close(); } catch {}
  decoderChannels = cfg.numberOfChannels;
  decoder = new AudioDecoder({
    output: (ad) => {
      try {
        const n = ad.numberOfFrames;
        const L = new Float32Array(n), R = new Float32Array(n);
        ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
        if (ad.numberOfChannels > 1) ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); else R.set(L);
        if (ad.sampleRate === SR) timeline.write(Math.round((ad.timestamp * SR) / 1e6), L, R);
      } finally { ad.close(); }
    },
    error: (err) => fail('decoder', err),
  });
  decoder.configure({
    codec: 'opus', sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels,
    description: cfg.description || undefined,
  });
}

function handleAlign({ reqId, snippet, hint }) {
  const snip = new Float32Array(snippet);
  const dur = snip.length / SR;
  const search = 0.75;
  const a = Math.max(0, hint - dur - search), b = hint + search;
  const out = { type: 'aligned', reqId, ok: false };
  if (timeline.coverage(a, b) > 0.9) {
    const { L, R } = timeline.read(a, b);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    const r = alignSnippet(snip, mono);
    Object.assign(out, { ok: r.score > 0.6, mediaStart: a + r.lag / SR, score: r.score, scale: r.scale });
  } else {
    out.reason = 'no decoded audio around the playhead yet';
  }
  send(out);
}

let timer = null;
function schedule(delay = 0) {
  if (timer || !ready) return; // one pending wake-up at most
  timer = setTimeout(() => { timer = null; work(); }, delay);
}

// First moment at or after t that no separated stretch covers (gaps under 0.15 s count as covered).
function firstGap(t) {
  for (const [s, e] of spans) if (s <= t + 0.15 && e > t) t = e;
  return t;
}
const nextSpanStart = (t) => { for (const [s] of spans) if (s > t + 1e-3) return s; return Infinity; };
// End of the decoded audio that runs on without a gap from t (up to `limit`).
function decodedUntil(t, limit) {
  let e = t;
  while (e < limit - 1e-6 && timeline.coverage(e, Math.min(limit, e + 0.1)) > 0.98) e = Math.min(limit, e + 0.1);
  return e;
}

/**
 * The next stretch to separate: the first one after the playhead without separated audio. When the
 * playhead would get there before a full job could finish (start of a video, after a seek, or when
 * separation fell behind), the job is shorter and starts further ahead, where the playhead will be when
 * it is done. The AI track then starts sooner and plays on without gaps; Live mode covers what is skipped.
 * Returns { a, c0, c1, b } (read from a to b, keep the core c0..c1), or null to wait.
 */
function choose() {
  const P = state.playhead, dur = state.duration;
  const horizon = Math.min(P + LOOKAHEAD, dur);
  let c0 = firstGap(P);
  if (c0 >= horizon - 0.25) return null;
  const spd = speed || 1.8;
  const jobTime = (len) => (len + 2 * CTX) / spd + 0.7; // + time to deliver it and lock on
  let len = CHUNK;
  const urgent = state.playing && c0 - P < jobTime(CHUNK);
  if (urgent) {
    len = SHORT;
    c0 = firstGap(Math.max(c0, P + jobTime(SHORT)));
    if (c0 >= horizon - 0.25) return null;
  }
  let c1 = Math.min(c0 + len, nextSpanStart(c0), dur);
  const avail = decodedUntil(c0, Math.min(c1 + CTX, dur));
  if (avail - c0 < Math.min(MIN_JOB, c1 - c0) - 1e-6) return null; // its audio isn't decoded yet
  // Not needed soon: wait until the whole chunk and its right-hand context are decoded (fewer, better jobs).
  if (!urgent && avail < Math.min(c1 + CTX, dur) - 0.05 && c0 - P > jobTime(CHUNK) + 3) return null;
  c1 = Math.min(c1, avail);
  const a = timeline.coverage(Math.max(0, c0 - CTX), c0) > 0.98 ? Math.max(0, c0 - CTX) : c0;
  return { a, c0, c1, b: avail };
}

async function work() {
  if (busy || !ready) return;
  timeline.evict(state.playhead - BEHIND - CHUNK, state.playhead + LOOKAHEAD + 60);
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i][1] < state.playhead - BEHIND) spans.splice(i, 1);
  const pick = state.enabled ? choose() : null;
  status();
  if (!pick) { schedule(300); return; }

  busy = true;
  const gen = generation;
  const { a, c0, c1, b } = pick;
  try {
    const { L, R } = timeline.read(a, b);
    const t0 = performance.now();
    const res = await separateBlock(L, R, { run, voiceModel: () => createRnnoiseVoice(rnn) }, { protect: settings.protect, keep: { music: 0, speech: 1, sfx: settings.sfx } });
    const secs = (performance.now() - t0) / 1000;
    speed = speed ? 0.7 * speed + 0.3 * ((b - a) / secs) : (b - a) / secs;
    lastShare = res.share;
    if (gen === generation) {
      const s0 = Math.max(a, c0 - OVERLAP);
      const s1 = Math.min(b, c1 + OVERLAP);
      const i0 = Math.round((s0 - a) * SR), i1 = Math.round((s1 - a) * SR);
      const outL = res.L.slice(i0, i1), outR = res.R.slice(i0, i1);
      let ei = 0, eo = 0;
      for (let i = i0; i < i1; i++) { ei += L[i] * L[i] + R[i] * R[i]; eo += outL[i - i0] * outL[i - i0] + outR[i - i0] * outR[i - i0]; }
      lastRemoved = ei > 1e-9 ? 1 - eo / ei : 0;
      spans.push([c0, c1]);
      spans.sort((x, y) => x[0] - y[0]);
      send({ type: 'chunk', start: s0, L: outL, R: outR, share: res.share }, [outL.buffer, outR.buffer]);
    }
  } catch (err) {
    fail('separate', err);
  } finally {
    busy = false;
    status();
    schedule(0);
  }
}

let lastStatus = 0;
function status() {
  const now = performance.now();
  if (now - lastStatus < 500) return;
  lastStatus = now;
  send({
    type: 'status', ready, speed, share: lastShare, chunkRemoved: lastRemoved, protect: settings.protect, sfx: settings.sfx,
    decodedTo: timeline.end(), chunks: spans.length, channels: decoderChannels,
  });
}
