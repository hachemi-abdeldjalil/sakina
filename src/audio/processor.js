// AudioWorklet processor. Bundled to dist/worklet.js.
//
// v1 (always running): live MusicSuppressor + RNNoise voice protection, ~73 ms behind the input.
// v2 (when ready):     plays chunks separated ahead of time by the AI model, locked to the live input
//                      by the content script's alignment, with no added delay.
// The output crossfades (10 ms) to v1 whenever v2 has nothing for the current moment
// (start of a video, right after a seek, model too slow, alignment lost).
import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';
import { MusicSuppressor } from '../dsp/suppressor.js';
import { createRnnoiseVoice } from '../dsp/rnnoise-voice.js';
import { ChunkPlayer } from './player.js';

const SNIPPET = 16384;           // samples of live input kept for alignment (~0.34 s)
const RING = SNIPPET * 2;
const FADE = 480;                // 10 ms

class SakinaProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBinary, ...params } = options.processorOptions || {};
    this.params = params;
    this.s = new MusicSuppressor(sampleRate, params);
    this.blocks = 0;
    this.reduction = 0;

    this.player = new ChunkPlayer(sampleRate);
    this.v2 = !!params.v2;
    this.mix = 0;            // 0 = v1 output, 1 = v2 output
    this.v2Quanta = 0;
    this.ring = new Float32Array(RING);
    this.ringPos = 0;
    this.lastFrameEnd = 0;
    this.tmpL = new Float32Array(128); this.tmpR = new Float32Array(128);
    this.inE = 0; this.outE = 0;
    this.v1L = new Float32Array(128); this.v1R = new Float32Array(128);

    this.port.onmessage = (e) => this.onMessage(e.data || {});
    if (wasmBinary && sampleRate === 48000) {
      createRNNWasmModule({ wasmBinary })
        .then((Module) => {
          this.s = new MusicSuppressor(sampleRate, { ...this.params, voice: createRnnoiseVoice(Module) });
          this.port.postMessage({ voice: true });
        })
        .catch((err) => this.port.postMessage({ voiceError: String(err?.message || err) }));
    }
  }

  onMessage(d) {
    switch (d.type) {
      case 'chunk': this.player.addChunk(d.start, d.L, d.R); break;
      case 'map': this.player.setMap(d.frame0, d.media0); break;
      case 'unmap': this.player.clearMap(); break;
      case 'clear': this.player.clearChunks(); this.player.clearMap(); break;
      case 'gain': this.player.gain = d.gain; break;
      case 'v2': this.v2 = !!d.on; if (!this.v2) this.player.clearMap(); break;
      case 'snippet': {
        const out = new Float32Array(SNIPPET);
        for (let i = 0; i < SNIPPET; i++) out[i] = this.ring[(this.ringPos - SNIPPET + i + RING) % RING];
        this.port.postMessage({ type: 'snippet', reqId: d.reqId, data: out, endFrame: this.lastFrameEnd }, [out.buffer]);
        break;
      }
      default:
        if (d.type === undefined) { this.params = { ...this.params, ...d }; this.s.setParams(d); } // v1 settings
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0], outR = output[1] || null, n = outL.length;
    const input = inputs[0];
    const inL = input && input.length ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : inL;

    // live input history for alignment (mono)
    for (let i = 0; i < n; i++) {
      this.ring[this.ringPos] = inL ? 0.5 * (inL[i] + inR[i]) : 0;
      this.ringPos = (this.ringPos + 1) % RING;
    }
    this.lastFrameEnd = currentFrame + n;

    // v1, always (keeps its state warm for instant fallback)
    if (this.v1L.length !== n) { this.v1L = new Float32Array(n); this.v1R = new Float32Array(n); this.tmpL = new Float32Array(n); this.tmpR = new Float32Array(n); }
    if (inL) this.s.process(inL, inR, this.v1L, this.v1R);
    else { const z = new Float32Array(n); this.s.process(z, z, this.v1L, this.v1R); }

    let covered = false;
    if (this.v2) covered = this.player.render(currentFrame, n, this.tmpL, this.tmpR);
    if (covered) this.v2Quanta++;
    const target = covered ? 1 : 0;
    for (let i = 0; i < n; i++) {
      if (this.mix !== target) this.mix = target > this.mix ? Math.min(1, this.mix + 1 / FADE) : Math.max(0, this.mix - 1 / FADE);
      const m = this.mix;
      const a = covered ? this.tmpL[i] : 0, b = covered ? this.tmpR[i] : 0;
      outL[i] = m * a + (1 - m) * this.v1L[i];
      if (outR) outR[i] = m * b + (1 - m) * this.v1R[i];
    }

    // measured: share of the input's energy that is not in the output (v1 or v2, whichever plays)
    if (inL) for (let i = 0; i < n; i++) { this.inE += inL[i] * inL[i] + inR[i] * inR[i]; this.outE += outL[i] * outL[i] + (outR ? outR[i] * outR[i] : outL[i] * outL[i]); }
    this.reduction = 0.9 * this.reduction + 0.1 * this.s.lastReduction;
    if (++this.blocks % 94 === 0) {
      const m = this.player.mediaAt(currentFrame);
      if (m !== null) this.player.evictBefore(m, 60);
      const removed = this.inE > 1e-6 ? Math.max(0, 1 - this.outE / this.inE) : 0;
      this.removed = this.removed === undefined ? removed : 0.7 * this.removed + 0.3 * removed;
      this.inE = 0; this.outE = 0;
      this.port.postMessage({
        reduction: this.reduction, removed: this.removed, vad: this.s.vad ?? null,
        v2Share: this.v2Quanta / 94, readyAhead: m === null ? 0 : this.player.readyAhead(m),
        locked: m !== null, chunks: this.player.chunks.length,
      });
      this.v2Quanta = 0;
    }
    return true;
  }
}

registerProcessor('sakina-music-remover', SakinaProcessor);
