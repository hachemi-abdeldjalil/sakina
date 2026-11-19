// Content script for youtube.com: finds the active video and hands it to the sound engines.
import { DEFAULTS, loadSettings, onSettingsChanged } from '../shared/settings.js';
import { AudioEngine } from '../audio/engine.js';
import { V2Controller } from './v2.js';

// Runs at document_start. The v2 controller is created first, synchronously, so it hears the page's
// very first captured audio bytes (the stream header) before anything else happens.
const early = { audio: new AudioEngine(DEFAULTS) };
early.v2 = new V2Controller(early.audio, DEFAULTS);

(async () => {
  const settings = await loadSettings();
  const audio = early.audio;
  audio.update(settings);
  const v2 = early.v2;
  v2.update(settings);
  // Visible only inside the extension's isolated world (not to YouTube's scripts); used by tests.
  globalThis.__sakina = { audio, v2 };

  function activeVideo() {
    const main = document.querySelector('#movie_player video.html5-main-video');
    if (main && isVisible(main)) return main;
    // Shorts and other players: the largest visible video, preferring one that is playing.
    let best = null, bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!isVisible(v)) continue;
      const r = v.getBoundingClientRect();
      const score = r.width * r.height * (v.paused ? 1 : 4);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best || main;
  }

  function isVisible(v) {
    const r = v.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  }

  function scan() {
    const v = activeVideo();
    if (!v) return;
    audio.attach(v);
    v2.attach(v);
  }

  // Media events don't bubble, but a capturing listener on the document sees them.
  document.addEventListener('play', scan, true);
  document.addEventListener('loadeddata', scan, true);
  window.addEventListener('yt-navigate-finish', scan);
  setInterval(scan, 1500);
  scan();

  onSettingsChanged((patch) => {
    audio.update(patch);
    v2.update(patch);
    scan();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'sakina:status') {
      reply({ audio: audio.status(), v2: v2.status(), mode: v2.settings.mode, hasVideo: !!activeVideo() });
    }
  });
})();
