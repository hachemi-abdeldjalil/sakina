export const DEFAULTS = {
  musicOn: true,
  mode: 'ai',        // 'ai' = separate ahead with the AI model (v2), 'live' = live processing only (v1)
  strength: 0.8,     // 0..1
  voiceFocus: 0.4,   // 0..1, turns down stereo sides
  voiceProtect: 1,   // 0..1, keeps voices (speech, recitation) the voice model detects
  keepSfx: true,     // false = remove sound effects too, so only voices are left
};

export async function loadSettings() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...got };
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
    cb(patch);
  });
}
