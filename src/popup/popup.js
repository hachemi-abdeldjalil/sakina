import { loadSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const save = (patch) => chrome.storage.sync.set(patch);

async function init() {
  const s = await loadSettings();
  $('musicOn').checked = s.musicOn;
  $('keepSfx').checked = s.keepSfx;
  $('strength').value = s.strength;
  $('voiceFocus').value = s.voiceFocus;
  $('voiceProtect').value = s.voiceProtect;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  try { $('more').open = localStorage.getItem('sakina:more') === '1'; } catch {}
  paint();

  $('musicOn').addEventListener('change', (e) => { save({ musicOn: e.target.checked }); paint(); refresh(); });
  $('keepSfx').addEventListener('change', (e) => { save({ keepSfx: e.target.checked }); paint(); refresh(); });
  for (const id of ['strength', 'voiceFocus', 'voiceProtect']) {
    $(id).addEventListener('change', (e) => save({ [id]: Number(e.target.value) }));
  }
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', (e) => { save({ mode: e.target.value }); paint(); });
  }
  $('more').addEventListener('toggle', () => { try { localStorage.setItem('sakina:more', $('more').open ? '1' : '0'); } catch {} });

  refresh();
  setInterval(refresh, 800);
}

const mode = () => document.querySelector('input[name="mode"]:checked')?.value || 'ai';

function paint() {
  const on = $('musicOn').checked;
  document.body.classList.toggle('off', !on);
  $('keepSfxHint').textContent = $('keepSfx').checked
    ? 'Footsteps, doors and applause stay.'
    : 'Removed too, so only voices are left.';
  const best = mode() === 'ai';
  $('modeHint').textContent = best
    ? 'Prepares the sound a moment ahead. Removes the most music.'
    : 'Works instantly and uses less of your computer. Removes less music.';
  $('strengthRow').hidden = best; // strength only tunes Light
}

function setStatus(text, warn = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

async function refresh() {
  if (!$('musicOn').checked) return setStatus('Off. Videos play with their music.');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st = null;
  if (tab?.id !== undefined) {
    try { st = await chrome.tabs.sendMessage(tab.id, { type: 'sakina:status' }); } catch {}
  }
  if (!st) {
    return setStatus(/youtube\.com/.test(tab?.url || '') ? 'Reload this YouTube tab to start.' : 'Open a YouTube video to use Sakina.');
  }
  const a = st.audio;
  if (!st.hasVideo) return setStatus('No video on this page yet.');
  if (a.mode === 'waiting') return setStatus('Click anywhere on the YouTube page to start.', true);
  if (a.mode === 'error') return setStatus(`Sakina could not start on this video (${a.error}). Reload the tab.`, true);
  const kept = $('keepSfx').checked ? 'Voices, recitation and sound effects stay.' : 'Only voices and recitation stay.';
  if (st.mode !== 'ai') return setStatus(`Removing music as the video plays. ${kept}`);
  const v2 = st.v2;
  if (v2?.state === 'error') return setStatus(`Using Light quality on this video. ${kept}`);
  if ((a.v2?.share ?? 0) > 0.5) return setStatus(`Removing music. ${kept}`);
  setStatus('Getting ready. Some music may come through for a moment.');
}

init();
