// Samples video frames, asks the classifier, and blurs the player when a frame looks 18+.

const THRESHOLDS = { strict: 0.3, balanced: 0.5, relaxed: 0.72 };
const SEXY_WEIGHT = { strict: 1.0, balanced: 0.6, relaxed: 0.3 };
const CALM_MS = 400;      // sampling period when things look safe
const ALERT_MS = 150;     // sampling period when a frame looked borderline or blurred
const RELEASE_SAMPLES = 4; // safe samples in a row before the blur comes off

export class BlurController {
  constructor(settings) {
    this.settings = settings;
    this.video = null;
    this.timer = 0;
    this.blurred = false;
    this.safeStreak = 0;
    this.score = 0;
    this.state = 'off';   // 'off' | 'loading' | 'watching' | 'error'
    this.error = '';
    this.allowedVideo = ''; // video id the user chose to show anyway
    this.canvas = document.createElement('canvas');
    this.canvas.width = 224;
    this.canvas.height = 224;
    this.c2d = this.canvas.getContext('2d', { willReadFrequently: true });
    this.mod = null;
    this.busy = false;
    injectStyle();
  }

  status() {
    return { state: this.state, score: this.score, blurred: this.blurred, error: this.error };
  }

  update(settings) {
    this.settings = { ...this.settings, ...settings };
    if (!this.settings.blurOn) this._stop();
    else this._start();
  }

  attach(video) {
    if (video !== this.video) {
      this._setBlur(false);
      this.video = video;
    }
    if (this.settings.blurOn) this._start();
  }

  async _start() {
    if (this.timer || !this.video) return;
    if (!this.mod) {
      this.state = 'loading';
      try {
        this.mod = await import(chrome.runtime.getURL('dist/classifier.js'));
        await this.mod.loadModel();
      } catch (err) {
        this.state = 'error';
        this.error = String(err?.message || err);
        console.warn('[Sakina] classifier failed to load', err);
        return;
      }
    }
    if (!this.settings.blurOn) { this.state = 'off'; return; }
    this.state = 'watching';
    this._schedule(0);
  }

  _stop() {
    clearTimeout(this.timer);
    this.timer = 0;
    this._setBlur(false);
    this.state = 'off';
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    const v = this.video;
    if (!this.settings.blurOn || !v) { this.timer = 0; return; }
    const playingVisible = !document.hidden && v.readyState >= 2 && v.videoWidth > 0;
    if (!playingVisible || this.busy) return this._schedule(CALM_MS);
    if (this._videoId() && this._videoId() === this.allowedVideo) {
      this._setBlur(false);
      return this._schedule(1000);
    }

    this.busy = true;
    let p;
    try {
      // Square center crop of the frame, scaled to the model's 224×224 input.
      const s = Math.min(v.videoWidth, v.videoHeight);
      const sx = (v.videoWidth - s) / 2, sy = (v.videoHeight - s) / 2;
      this.c2d.drawImage(v, sx, sy, s, s, 0, 0, 224, 224);
      p = await this.mod.classify(this.canvas);
    } catch (err) {
      this.busy = false;
      this.state = 'error';
      this.error = String(err?.message || err);
      return this._schedule(2000);
    }
    this.busy = false;
    this.state = 'watching';

    const sens = this.settings.sensitivity in THRESHOLDS ? this.settings.sensitivity : 'balanced';
    const score = p.Porn + p.Hentai + SEXY_WEIGHT[sens] * p.Sexy;
    this.score = score;
    const thr = THRESHOLDS[sens];
    if (score >= thr) {
      this.safeStreak = 0;
      this._setBlur(true);
    } else if (this.blurred && ++this.safeStreak >= RELEASE_SAMPLES) {
      this._setBlur(false);
    }
    const alert = this.blurred || score >= thr * 0.5;
    this._schedule(alert ? ALERT_MS : CALM_MS);
  }

  _videoId() {
    return new URL(location.href).searchParams.get('v') || location.pathname;
  }

  _setBlur(on) {
    if (on === this.blurred && this.video?.classList.contains('sakina-blur') === on) return;
    this.blurred = on;
    if (!this.video) return;
    this.video.classList.toggle('sakina-blur', on);
    const player = this.video.closest('#movie_player, .html5-video-player, ytd-reel-video-renderer') || this.video.parentElement;
    let badge = player?.querySelector(':scope > .sakina-badge');
    if (on && player && !badge) {
      badge = document.createElement('div');
      badge.className = 'sakina-badge';
      const label = document.createElement('span');
      label.textContent = 'Hidden by Sakina';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Show this video';
      badge.append(label, btn);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.allowedVideo = this._videoId();
        this._setBlur(false);
      });
      player.appendChild(badge);
    }
    if (badge) badge.hidden = !on;
  }
}

function injectStyle() {
  if (document.getElementById('sakina-style')) return;
  const st = document.createElement('style');
  st.id = 'sakina-style';
  st.textContent = `
    video.sakina-blur { filter: blur(48px) brightness(0.7) !important; transition: filter .08s linear; }
    .sakina-badge { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 60;
      display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 999px;
      background: rgba(15, 23, 20, .85); color: #fff; font: 500 13px/1.2 Roboto, Arial, sans-serif; }
    .sakina-badge[hidden] { display: none; }
    .sakina-badge button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
      background: rgba(255,255,255,.16); font-weight: 600; }
    .sakina-badge button:hover { background: rgba(255,255,255,.28); }
  `;
  (document.head || document.documentElement).appendChild(st);
}
