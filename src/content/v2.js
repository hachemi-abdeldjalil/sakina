// Content-script side of v2 (AI separation ahead of playback).
//
//  main world capture ──bytes──▶ this controller ──port──▶ engine worker (in a hidden extension iframe)
//  engine worker ──separated chunks──▶ this controller ──▶ AudioWorklet player
//  AudioWorklet live snippet ──▶ engine "align" ──▶ worklet map (audio frame ↔ media time)
const TAG = '__sakina_mse__';
const SNIPPET = 16384;
const READY_TIMEOUT = 90000;
const REALIGN_MS = 5000;

export class V2Controller {
  constructor(audio, settings) {
    this.audio = audio;
    this.settings = settings;
    this.port = null;
    this.queue = [];          // captured messages waiting for the engine
    this.state = 'off';       // 'off' | 'loading' | 'ready' | 'error' | 'unsupported'
    this.error = '';
    this.worker = {};         // last worker status
    this.have = new Map();    // chunks the player holds: start → end (s)
    this.locked = false;
    this.lastAlign = 0;
    this.aligning = false;
    this.alignFails = 0;
    this.score = 0;
    this.reqId = 0;
    this.pending = new Map();
    this.video = null;
    this._onCapture = this._onCapture.bind(this);
    this._onVideoEvent = this._onVideoEvent.bind(this);
    // Listen from document_start so the stream header and first seconds are not missed.
    window.addEventListener('message', this._onCapture);
    setInterval(() => this._tick(), 500);
  }

  get enabled() { return this.settings.musicOn && this.settings.mode === 'ai'; }

  status() {
    return {
      state: this.state, error: this.error, locked: this.locked, score: this.score,
      speed: this.worker.speed || 0, decodedTo: this.worker.decodedTo || 0, share: this.worker.share || null,
      chunkRemoved: this.worker.chunkRemoved ?? null, protect: this.worker.protect ?? null,
      sfx: this.worker.sfx ?? null,
    };
  }

  update(settings) {
    const prevMode = this.settings.mode, prevProtect = this.settings.voiceProtect, prevSfx = this.settings.keepSfx;
    this.settings = { ...this.settings, ...settings };
    this.audio.post({ type: 'v2', on: this.enabled });
    if (!this.enabled) this._unlock();
    if (this.enabled && !this.port && this.state === 'off') this._start();
    if (this.port && (prevProtect !== this.settings.voiceProtect || prevSfx !== this.settings.keepSfx)) this._send(this._settingsMsg());
    if (prevMode !== this.settings.mode && this.enabled) this.lastAlign = 0;
  }

  attach(video) {
    if (video === this.video) return;
    for (const ev of ['seeking', 'seeked', 'pause', 'playing', 'waiting', 'ratechange', 'volumechange', 'emptied']) {
      this.video?.removeEventListener(ev, this._onVideoEvent);
      video?.addEventListener(ev, this._onVideoEvent);
    }
    this.video = video;
    this._unlock();
  }

  _protect() { return 1.3 * (this.settings.voiceProtect ?? 1); }

  // keepSfx false: the model's sound-effects layer is dropped along with the music.
  _settingsMsg() { return { type: 'settings', protect: this._protect(), sfx: this.settings.keepSfx === false ? 0 : 1 }; }

  _onCapture(e) {
    if (e.source !== window || !e.data || !e.data[TAG]) return;
    const d = e.data;
    if (d.kind === 'unsupported') { this.unsupported = d.mime; return; }
    if (d.kind !== 'new' && d.kind !== 'append') return;
    if (d.kind === 'new') { this.unsupported = ''; }
    const msg = d.kind === 'new' ? { type: 'new', id: d.id } : { type: 'append', id: d.id, bytes: d.bytes };
    if (this.port) this._send(msg, msg.bytes ? [msg.bytes.buffer] : []);
    else {
      if (d.kind === 'new') { this.queue = []; this.queued = 0; } // a new stream makes older bytes useless
      this.queue.push(msg);
      this.queued = (this.queued || 0) + (msg.bytes ? msg.bytes.length : 0);
      // Bounded: keep the stream header (first append) and drop the oldest audio after it.
      while (this.queued > 40 * 1048576 && this.queue.length > 3) {
        const [gone] = this.queue.splice(2, 1);
        this.queued -= gone.bytes ? gone.bytes.length : 0;
      }
      if (this.enabled && this.state === 'off') this._start();
    }
  }

  _start() {
    if (this.state !== 'off') return;
    this.state = 'loading';
    const inject = () => {
      const f = document.createElement('iframe');
      f.src = chrome.runtime.getURL('engine.html');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
      f.addEventListener('load', () => {
        const ch = new MessageChannel();
        this.port = ch.port1;
        this.port.onmessage = (m) => this._onEngine(m.data || {});
        f.contentWindow.postMessage({ type: 'sakina-connect' }, new URL(chrome.runtime.getURL('')).origin, [ch.port2]);
        const q = this.queue; this.queue = [];
        for (const msg of q) this._send(msg, msg.bytes ? [msg.bytes.buffer] : []);
        this._send(this._settingsMsg());
      }, { once: true });
      (document.body || document.documentElement).appendChild(f);
      setTimeout(() => {
        if (this.state === 'loading') { this.state = 'error'; this.error = 'the AI model did not load in time; using live mode'; }
      }, READY_TIMEOUT);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject, { once: true });
    else inject();
  }

  _send(msg, transfer) { try { this.port?.postMessage(msg, transfer || []); } catch {} }

  _onEngine(d) {
    switch (d.type) {
      case 'ready': this.state = 'ready'; this.error = ''; this.lastAlign = 0; break;
      case 'error': if (this.state !== 'ready') this.state = 'error'; this.error = d.error; console.warn('[Sakina v2]', d.error); break;
      case 'unsupported': this.error = d.reason; break;
      case 'status': this.worker = d; break;
      case 'cleared': this.have.clear(); this.audio.post({ type: 'clear' }); this.locked = false; break;
      case 'chunk':
        if (this.audio.post({ type: 'chunk', start: d.start, L: d.L, R: d.R }, [d.L.buffer, d.R.buffer])) this.have.set(d.start, d.start + d.L.length / 48000);
        break;
      case 'aligned': this.pending.get(d.reqId)?.(d); this.pending.delete(d.reqId); break;
    }
  }

  _onVideoEvent(e) {
    switch (e.type) {
      case 'seeking': case 'pause': case 'waiting': case 'emptied': case 'ratechange':
        this._unlock();
        if (e.type === 'seeking') this._send({ type: 'have', spans: [...this.have] });
        break;
      case 'seeked': case 'playing': case 'volumechange':
        this.lastAlign = 0; // re-align soon (the tick waits for fresh live audio)
        this.freshAfter = performance.now() + 450;
        break;
    }
  }

  _unlock() {
    if (this.locked) this.audio.post({ type: 'unmap' });
    this.locked = false;
    this.lastAlign = 0;
  }

  _tick() {
    const v = this.video;
    if (!this.port || !v) return;
    const playing = !v.paused && !v.ended && v.readyState >= 3;
    this._send({ type: 'playhead', t: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : 0, playing, rate: v.playbackRate, enabled: this.enabled });
    // Forget chunks a little before the player evicts them (60 s), so the worker never counts on one it lost.
    for (const [s, e] of [...this.have]) if (e < v.currentTime - 55) this.have.delete(s);
    if (!this.enabled || this.state !== 'ready' || !this.audio.filtering) return;
    if (!playing || v.playbackRate !== 1) { this._unlock(); return; } // time-stretched audio can't be matched
    if (this.aligning || performance.now() < (this.freshAfter || 0)) return;
    if (this.locked && performance.now() - this.lastAlign < REALIGN_MS) return;
    this._align();
  }

  async _align() {
    this.aligning = true;
    try {
      const snip = await this.audio.requestSnippet();
      if (!snip) return;
      const hint = this.video.currentTime;
      const reqId = ++this.reqId;
      const res = await new Promise((resolve) => {
        this.pending.set(reqId, resolve);
        this._send({ type: 'align', reqId, snippet: snip.data, hint }, [snip.data.buffer]);
        // The worker answers between separation jobs (up to ~5 s); a late answer is not a failure.
        setTimeout(() => { if (this.pending.has(reqId)) { this.pending.delete(reqId); resolve({ ok: false, timeout: true }); } }, 8000);
      });
      this.lastAlign = performance.now();
      if (res.timeout) return;
      this.score = res.score || 0;
      if (res.ok && !this.video.paused && performance.now() >= (this.freshAfter || 0)) {
        this.alignFails = 0;
        this.audio.post({ type: 'map', frame0: snip.endFrame - SNIPPET, media0: res.mediaStart });
        this.audio.post({ type: 'gain', gain: Math.max(0, Math.min(2, res.scale)) });
        this.locked = true;
      } else if (++this.alignFails >= 2) {
        this._unlock();
      }
    } finally {
      this.aligning = false;
    }
  }
}
