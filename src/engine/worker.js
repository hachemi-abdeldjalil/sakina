// Sakina v2 separation worker (module worker, extension origin, inside a hidden iframe on YouTube).
//
//   captured WebM/Opus bytes → demux → WebCodecs AudioDecoder → 48 kHz timeline
//   → 10 s chunks (+1 s context each side), nearest the playhead first
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
const done = new Set();  // chunk indices the player has (or will get)
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
      done.clear();
      for (const s of msg.starts) done.add(Math.round((s + OVERLAP) / CHUNK));
      break;
    case 'settings': {
      const next = { ...settings };
      if (msg.protect !== undefined) next.protect = msg.protect;
      if (msg.sfx !== undefined) next.sfx = msg.sfx;
      if (next.protect !== settings.protect || next.sfx !== settings.sfx) {
        settings = next; // chunks made with the old settings are thrown away and made again
        generation++;
        done.clear();
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
  done.clear();
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

async function work() {
  if (busy || !ready) return;
  timeline.evict(state.playhead - BEHIND - CHUNK, state.playhead + LOOKAHEAD + 60);
  for (const k of [...done]) if ((k + 1) * CHUNK < state.playhead - BEHIND) done.delete(k);

  const first = Math.max(0, Math.floor(state.playhead / CHUNK));
  const last = Math.floor((Math.min(state.playhead + LOOKAHEAD, state.duration)) / CHUNK);
  let pick = -1, pickEnd = 0;
  for (let k = first; k <= last; k++) {
    if (done.has(k)) continue;
    const core0 = k * CHUNK, core1 = Math.min((k + 1) * CHUNK, state.duration);
    if (core1 - core0 < 0.5) continue;
    if (timeline.coverage(core0, core1) < 0.98) break; // keep chunks contiguous: wait for this one's audio
    const full = Math.min(core1 + CTX, state.duration);
    let end = full;
    if (timeline.coverage(core1, full) < 0.98) {
      // Right-hand context not buffered yet. Wait for it, unless the playhead is about to need this chunk.
      if (core0 - state.playhead > 4) break;
      end = core1;
      while (end + 0.1 <= full && timeline.coverage(end, end + 0.1) > 0.98) end += 0.1;
    }
    pick = k; pickEnd = end;
    break;
  }
  status();
  if (pick < 0 || !state.enabled) { schedule(400); return; }

  busy = true;
  const gen = generation;
  const k = pick;
  try {
    const a = Math.max(0, k * CHUNK - CTX);
    const b = pickEnd;
    const { L, R } = timeline.read(a, b);
    const t0 = performance.now();
    const res = await separateBlock(L, R, { run, voiceModel: () => createRnnoiseVoice(rnn) }, { protect: settings.protect, keep: { music: 0, speech: 1, sfx: settings.sfx } });
    const secs = (performance.now() - t0) / 1000;
    speed = speed ? 0.7 * speed + 0.3 * ((b - a) / secs) : (b - a) / secs;
    lastShare = res.share;
    if (gen === generation) {
      const s0 = Math.max(a, k * CHUNK - OVERLAP);
      const s1 = Math.min(b, (k + 1) * CHUNK + OVERLAP);
      const i0 = Math.round((s0 - a) * SR), i1 = Math.round((s1 - a) * SR);
      const outL = res.L.slice(i0, i1), outR = res.R.slice(i0, i1);
      let ei = 0, eo = 0;
      for (let i = i0; i < i1; i++) { ei += L[i] * L[i] + R[i] * R[i]; eo += outL[i - i0] * outL[i - i0] + outR[i - i0] * outR[i - i0]; }
      lastRemoved = ei > 1e-9 ? 1 - eo / ei : 0;
      done.add(k);
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
    decodedTo: timeline.end(), chunks: done.size, channels: decoderChannels,
  });
}
