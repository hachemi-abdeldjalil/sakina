// Routes a <video> element's sound through the music remover.
//
// Safety rule: we only call createMediaElementSource once the AudioContext is
// actually running. Before that the video plays normally, so a blocked
// AudioContext can never leave the user with a silent video.
import { MusicSuppressor } from '../dsp/suppressor.js';

const sources = new WeakMap(); // video -> MediaElementAudioSourceNode (one per element, ever)

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.video = null;
    this.source = null;
    this.node = null;          // AudioWorkletNode or ScriptProcessorNode
    this.mode = 'off';         // 'off' | 'waiting' | 'worklet' | 'script' | 'error'
    this.reduction = 0;
    this.error = '';
    this._unlock = this._unlock.bind(this);
  }

  status() {
    return {
      mode: this.mode, reduction: this.reduction, error: this.error, ctx: this.ctx?.state || 'none',
      voice: this.voice, voiceError: this.voiceError || '', vad: this.vad,
      v2: this.v2Stats || null, removed: this.removed ?? null,
    };
  }

  /** Send a message to the worklet (used by the v2 controller). Returns false if there is no worklet. */
  post(msg, transfer) {
    if (this.kind !== 'worklet' || !this.node) return false;
    this.node.port.postMessage(msg, transfer || []);
    return true;
  }

  /** Last ~0.34 s of live input (mono) and the audio frame it ends at. */
  requestSnippet() {
    if (this.kind !== 'worklet' || !this.node) return Promise.resolve(null);
    const reqId = (this._snipId = (this._snipId || 0) + 1);
    return new Promise((resolve) => {
      this._snipWait = { reqId, resolve };
      this.node.port.postMessage({ type: 'snippet', reqId });
      setTimeout(() => { if (this._snipWait?.reqId === reqId) { this._snipWait = null; resolve(null); } }, 1000);
    });
  }

  /** True while the video's sound actually flows through the worklet. */
  get filtering() { return this.kind === 'worklet' && this.route === 'filtered' && this.ctx?.state === 'running'; }

  _params() {
    const { strength, voiceFocus, voiceProtect, keepSfx } = this.settings;
    return { strength, voiceFocus, voiceProtect, keepSfx };
  }

  update(settings) {
    this.settings = { ...this.settings, ...settings };
    this._sendParams();
    this._route();
  }

  async attach(video) {
    if (!video || video === this.video) return this._route();
    this.video = video;
    if (!this.settings.musicOn) return this._route();
    await this._ensureContext();
    this._route();
  }

  async _ensureContext() {
    if (!this.ctx) {
      // 48 kHz is what the voice model (RNNoise) is trained for; Chrome resamples if needed.
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      await this._createNode();
      this.ctx.addEventListener('statechange', () => this._route());
    }
    if (this.ctx.state !== 'running') {
      this.mode = 'waiting';
      try { await this.ctx.resume(); } catch {}
      if (this.ctx.state !== 'running') {
        // Needs a user gesture on the page; try again on the next click/key.
        window.addEventListener('pointerdown', this._unlock, true);
        window.addEventListener('keydown', this._unlock, true);
      }
    }
  }

  async _unlock() {
    if (!this.ctx) return;
    try { await this.ctx.resume(); } catch {}
    if (this.ctx.state === 'running') {
      window.removeEventListener('pointerdown', this._unlock, true);
      window.removeEventListener('keydown', this._unlock, true);
      this._route();
    }
  }

  async _createNode() {
    const opts = this._params();
    try {
      await this.ctx.audioWorklet.addModule(chrome.runtime.getURL('dist/worklet.js'));
      let wasmBinary = null;
      try {
        wasmBinary = await (await fetch(chrome.runtime.getURL('dist/rnnoise.wasm'))).arrayBuffer();
      } catch (err) {
        this.voiceError = 'voice model not loaded: ' + (err?.message || err);
      }
      this.node = new AudioWorkletNode(this.ctx, 'sakina-music-remover', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { ...opts, wasmBinary, v2: this.settings.mode === 'ai' },
      });
      this.voice = false;
      this.node.port.onmessage = (e) => {
        const d = e.data || {};
        if (d.reduction !== undefined) this.reduction = d.reduction;
        if (d.removed !== undefined) this.removed = d.removed;
        if (d.vad !== undefined) this.vad = d.vad;
        if (d.voice) this.voice = true;
        if (d.voiceError) this.voiceError = d.voiceError;
        if (d.v2Share !== undefined) this.v2Stats = { share: d.v2Share, readyAhead: d.readyAhead, locked: d.locked, chunks: d.chunks };
        if (d.type === 'snippet' && this._snipWait?.reqId === d.reqId) { this._snipWait.resolve(d); this._snipWait = null; }
      };
      this.kind = 'worklet';
    } catch (err) {
      // Some pages' security policy blocks worklets: fall back to the main thread.
      console.warn('[Sakina] AudioWorklet unavailable, using ScriptProcessor:', err);
      const sp = this.ctx.createScriptProcessor(1024, 2, 2);
      const s = new MusicSuppressor(this.ctx.sampleRate, opts);
      sp.onaudioprocess = (e) => {
        const ib = e.inputBuffer, ob = e.outputBuffer;
        s.process(ib.getChannelData(0), ib.getChannelData(ib.numberOfChannels > 1 ? 1 : 0),
          ob.getChannelData(0), ob.getChannelData(1));
        this.reduction = 0.8 * this.reduction + 0.2 * s.lastReduction;
      };
      this.suppressor = s;
      this.node = sp;
      this.kind = 'script';
    }
  }

  _sendParams() {
    const p = this._params();
    if (this.kind === 'worklet') this.node.port.postMessage(p);
    else if (this.suppressor) this.suppressor.setParams(p);
  }

  async _route() {
    const want = this.settings.musicOn;
    if (want && this.video && !this.ctx) await this._ensureContext();
    if (!this.ctx || !this.video || !this.node) { this.mode = want ? 'waiting' : 'off'; return; }
    if (this.ctx.state !== 'running') {
      if (want) { this.mode = 'waiting'; this._ensureContext(); }
      return; // not attached yet => element still plays on its own
    }

    // Once a source exists for an element, the element is silent unless the source
    // is connected to the destination, so every branch below must connect somewhere.
    let src = sources.get(this.video);
    if (!src) {
      if (!want) { this.mode = 'off'; return; }
      try {
        src = this.ctx.createMediaElementSource(this.video);
        sources.set(this.video, src);
      } catch (err) {
        this.mode = 'error';
        this.error = String(err?.message || err);
        return;
      }
    }
    const route = want ? 'filtered' : 'direct';
    if (this.source === src && this.route === route) return; // already wired this way
    if (this.source && this.source !== src) { try { this.source.disconnect(); } catch {} }
    this.source = src;
    this.route = route;
    try { src.disconnect(); } catch {}
    try { this.node.disconnect(); } catch {}
    if (want) {
      src.connect(this.node);
      this.node.connect(this.ctx.destination);
      this.mode = this.kind;
    } else {
      src.connect(this.ctx.destination);
      this.mode = 'off';
      this.reduction = 0;
    }
  }
}
