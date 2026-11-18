import { loadSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;

async function init() {
  const s = await loadSettings();
  $('musicOn').checked = s.musicOn;
  $('blurOn').checked = s.blurOn;
  $('strength').value = s.strength;
  $('voiceFocus').value = s.voiceFocus;
  $('voiceProtect').value = s.voiceProtect;
  $('keepSfx').checked = s.keepSfx;
  for (const r of document.querySelectorAll('input[name="sensitivity"]')) r.checked = r.value === s.sensitivity;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  paintLabels();

  const save = (patch) => chrome.storage.sync.set(patch);
  $('musicOn').addEventListener('change', (e) => { save({ musicOn: e.target.checked }); paintLabels(); });
  $('blurOn').addEventListener('change', (e) => { save({ blurOn: e.target.checked }); paintLabels(); });
  $('keepSfx').addEventListener('change', (e) => { save({ keepSfx: e.target.checked }); paintLabels(); });
  for (const id of ['strength', 'voiceFocus', 'voiceProtect']) {
    $(id).addEventListener('input', paintLabels);
    $(id).addEventListener('change', (e) => save({ [id]: Number(e.target.value) }));
  }
  for (const r of document.querySelectorAll('input[name="sensitivity"]')) {
    r.addEventListener('change', (e) => save({ sensitivity: e.target.value }));
  }
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', (e) => save({ mode: e.target.value }));
  }

  refresh();
  setInterval(refresh, 600);
}

function paintLabels() {
  $('strengthVal').textContent = pct($('strength').value);
  $('voiceFocusVal').textContent = pct($('voiceFocus').value);
  $('voiceProtectVal').textContent = pct($('voiceProtect').value);
  $('keepSfxHint').textContent = $('keepSfx').checked ? 'Footsteps, doors, applause stay.' : 'Removed too: only voices stay.';
  $('music-card').classList.toggle('off', !$('musicOn').checked);
  $('blur-card').classList.toggle('off', !$('blurOn').checked);
}

function paintAi(st, musicOn) {
  const el = $('aiStatus');
  const v2 = st.v2, w = st.audio?.v2;
  el.hidden = !(musicOn && st.mode === 'ai');
  if (el.hidden || !v2) return;
  let text, warn = false;
  if (v2.state === 'off') text = 'AI model: starting…';
  else if (v2.state === 'loading') text = 'AI model: loading (about 40 MB, first time only)…';
  else if (v2.state === 'error') { text = `AI unavailable, using live mode. ${v2.error}`; warn = true; }
  else if (w && w.share > 0.5) text = `AI active: ${Math.round(w.readyAhead)} s separated ahead · ${v2.speed.toFixed(1)}× real time.`;
  else if (v2.locked) text = 'AI ready, waiting for the separated audio to catch up (live mode meanwhile).';
  else text = 'AI ready: syncing with the video (live mode meanwhile).';
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

function setStatus(id, text, warn = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st = null;
  if (tab?.id !== undefined) {
    try { st = await chrome.tabs.sendMessage(tab.id, { type: 'sakina:status' }); } catch {}
  }
  if (!st) {
    const onYT = /youtube\.com/.test(tab?.url || '');
    const msg = onYT ? 'Reload this YouTube tab to start.' : 'Open a YouTube video to use Sakina.';
    setStatus('musicStatus', msg);
    setStatus('blurStatus', msg);
    $('musicMeter').style.width = '0';
    return;
  }

  const a = st.audio;
  const musicOn = $('musicOn').checked;
  if (!musicOn) setStatus('musicStatus', 'Off: sound plays untouched.');
  else if (!st.hasVideo) setStatus('musicStatus', 'No video on this page yet.');
  else if (a.mode === 'waiting') setStatus('musicStatus', 'Click anywhere on the page to start.', true);
  else if (a.mode === 'error') setStatus('musicStatus', `Could not attach: ${a.error}`, true);
  else {
    const voice = a.voice ? (a.vad > 0.8 ? ' Voice detected, keeping it.' : '') : ' (voice protection unavailable)';
    const shown = a.removed ?? a.reduction;
    setStatus('musicStatus', `Active: removing ${pct(shown)} of the sound right now.${voice}`);
  }
  $('musicMeter').style.width = musicOn ? pct(Math.min(1, a.removed ?? a.reduction)) : '0';
  paintAi(st, musicOn);

  const b = st.blur;
  if (!$('blurOn').checked) setStatus('blurStatus', 'Off.');
  else if (b.state === 'loading') setStatus('blurStatus', 'Loading the scene checker…');
  else if (b.state === 'error') setStatus('blurStatus', `Problem: ${b.error}`, true);
  else if (b.blurred) setStatus('blurStatus', 'Blurring the current scene.', true);
  else if (b.state === 'watching') setStatus('blurStatus', `Watching scenes (last score ${pct(b.score)}).`);
  else setStatus('blurStatus', 'Waiting for a video.');
}

init();
