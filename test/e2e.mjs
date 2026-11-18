// End-to-end check on real YouTube: npm run e2e   (Chrome runs muted and off-screen; ~8 min with ads)
// For each video: v2 (AI separation ahead of playback) must load, lock onto the live audio, supply most
// of the output, remove music and keep speech/recitation. Then live mode, toggles and the blur path.
import { launch } from '../scripts/chrome.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  // How much music the model catches varies by passage, hence the generous music floor.
  { name: 'instrumental music', query: 'relaxing piano music instrumental', removed: [0.6, 1.01] },
  { name: 'talk (speech)', query: 'ted talk', removed: [0, 0.35], warm: 22000 }, // past the intro jingle
  { name: 'quran recitation', query: 'quran recitation', removed: [0, 0.4], seekBack: true },
];

const b = await launch({
  extraArgs: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-position=3000,3000', '--window-size=1280,800'],
});
const control = await b.open(`chrome-extension://${b.extensionId}/popup.html`);
const status = () => control.evaluate(`(async () => {
  for (const t of await chrome.tabs.query({})) {
    try { const s = await chrome.tabs.sendMessage(t.id, { type: 'sakina:status' }); if (s) return s; } catch {}
  }
  return null;
})()`);
const setSettings = (p) => control.evaluate(`chrome.storage.sync.set(${JSON.stringify(p)})`);

const yt = await b.open('about:blank');
await yt.send('Runtime.enable');
const errors = [];
let iso = null;
b.onEvent((m) => {
  if (m.method === 'Runtime.executionContextCreated' && m.params.context.auxData?.type === 'isolated' && /Sakina/.test(m.params.context.name)) iso = m.params.context.id;
  const text = m.method === 'Runtime.exceptionThrown' ? JSON.stringify(m.params.exceptionDetails)
    : m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type) ? JSON.stringify(m.params) : '';
  if (text.includes(b.extensionId) || text.includes('[Sakina')) errors.push(text.slice(0, 400));
});
const evalIso = async (expr) => {
  const r = await yt.send('Runtime.evaluate', { expression: expr, contextId: iso, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const now = () => yt.evaluate(`document.querySelector('video.html5-main-video').currentTime`);
// YouTube in a fresh profile shows "YouTube Premium" upsell dialogs that pause playback: dismiss them.
const dismiss = () => yt.evaluate(`(() => {
  for (const b of document.querySelectorAll('tp-yt-paper-dialog button, ytd-popup-container button, yt-button-renderer button')) {
    if (/^(no thanks|not now|dismiss|skip trial)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())) b.click();
  }
  const v = document.querySelector('video.html5-main-video');
  if (v && v.paused && !document.querySelector('.ad-interrupting')) document.getElementById('movie_player')?.playVideo?.();
})()`);

// Opens a search result and waits for its own content (not an ad) to play. A fresh profile sometimes gets
// an ad that never ends in automation; then it tries the next result instead of measuring the ad.
async function openVideo(query) {
  let hrefs = [];
  for (let attempt = 0; attempt < 3 && !hrefs.length; attempt++) {
    await yt.send('Page.navigate', { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` });
    await sleep(5000 + attempt * 3000);
    hrefs = await yt.evaluate(`[...new Set([...document.querySelectorAll('a#video-title')].map(a => a.href).filter(h => h.includes('/watch?v=')).map(h => h.split('&')[0]))]`);
  }
  if (!hrefs.length) throw new Error(`no search results for "${query}"`);
  let r;
  for (const href of hrefs.slice(0, 3)) {
    r = await playWhenReady(href);
    if (r.ready) break;
    console.log(`  (no content after ${r.waited} s, probably an ad: trying the next result)`);
  }
  return r;
}

async function playWhenReady(href) {
  await yt.send('Page.navigate', { url: href });
  // Ready = no ad showing and the video's own time is advancing.
  let ready = false, prev = -1, i = 0;
  for (; i < 30 && !ready; i++) {
    await sleep(2000);
    await yt.evaluate(`document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-skip-ad button')?.click()`);
    await dismiss();
    // '.ad-showing' can linger for overlay/product-shelf ads; '.ad-interrupting' is set only while a video ad plays.
    const st = await yt.evaluate(`(() => { const v = document.querySelector('video.html5-main-video'); return { ad: !!document.querySelector('.ad-interrupting'), t: v ? v.currentTime : -1 }; })()`);
    ready = !st.ad && prev >= 0 && st.t > prev;
    prev = st.ad ? -1 : st.t;
  }
  return { href, ready, waited: i * 2 };
}

async function sample(seconds) {
  const s = [];
  for (let i = 0; i < seconds; i++) { await sleep(1000); await dismiss(); s.push(await status()); }
  return s;
}

for (const c of CASES) {
  const { href, ready } = await openVideo(c.query);
  console.log(`\n${c.name}: ${href}`);
  check(ready, 'video content started (after any ads)');
  for (let w = 0; w < (c.warm || 14000); w += 2000) { await sleep(2000); await dismiss(); } // warm-up: model load, decode, first chunk, alignment
  const t0 = await now();
  const s = await sample(12);
  const t1 = await now();
  const last = s.at(-1);
  const avg = (f) => s.reduce((a, x) => a + (f(x) ?? 0), 0) / s.length;
  const v2share = avg((x) => x?.audio?.v2?.share);
  const removed = avg((x) => x?.audio?.removed);
  console.log(`  v2 state=${last?.v2?.state} locked=${last?.v2?.locked} align score=${last?.v2?.score?.toFixed(4)} speed=${last?.v2?.speed?.toFixed(2)}x ready ahead=${last?.audio?.v2?.readyAhead?.toFixed(1)}s`);
  console.log(`  output from AI track ${(v2share * 100).toFixed(0)}%, sound removed ${(removed * 100).toFixed(0)}% (per second: ${s.map((x) => ((x?.audio?.removed ?? 0) * 100).toFixed(0)).join(',')})`);
  check(last?.v2?.state === 'ready', `AI engine ready ${last?.v2?.error || ''}`);
  check(t1 - t0 > 10, `video keeps playing (${(t1 - t0).toFixed(1)} s in 12 s)`);
  check(last?.v2?.locked && last?.v2?.score > 0.95, 'locked onto the live audio');
  check(v2share > 0.8, 'most of the output comes from the AI track');
  check(removed >= c.removed[0] && removed <= c.removed[1], `sound removed in expected range ${c.removed.map((x) => Math.round(x * 100)).join('–')}%`);
  check(!last?.blur?.blurred && last?.blur?.state === 'watching', 'scene checker watching, nothing blurred');
  if (c.seekBack) {
    // Seek back 8 s (already buffered): v2 must drop its lock, fall back to live, then re-lock.
    await yt.evaluate(`(() => { const p = document.getElementById('movie_player'); p.seekTo(Math.max(0, p.getCurrentTime() - 8), true); })()`);
    await sleep(10000);
    const after = await sample(4);
    const share = after.reduce((a, x) => a + (x?.audio?.v2?.share ?? 0), 0) / after.length;
    check(share > 0.5 && after.at(-1)?.v2?.locked, `after seeking back 8 s the AI track is back (${(share * 100).toFixed(0)}%)`);
  }
}

// YouTube now stops automated browsers after ~40 s of playback ("Something went wrong"), with or without
// Sakina (checked 2026-11-18 with the extension not loaded). So each later section starts on a fresh video
// and stays under that.
async function fresh(query) {
  const { href, ready } = await openVideo(query);
  console.log(`  (${href})`);
  check(ready, 'video content started (after any ads)');
  for (let i = 0; i < 24; i++) {
    await sleep(1000); await dismiss();
    const st = await status();
    if (st?.v2?.locked && (st?.audio?.v2?.share ?? 0) > 0.8) break;
  }
}
const mean = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0) / xs.length;

console.log('\nLive mode and back');
await fresh('relaxing piano music instrumental');
await setSettings({ mode: 'live' });
await sleep(3000);
let s = await sample(3);
check(s.every((x) => (x?.audio?.v2?.share ?? 0) === 0) && s.at(-1)?.audio?.mode === 'worklet', 'live mode: AI track not used, live processing on');
await setSettings({ mode: 'ai' });
await sleep(9000);
s = await sample(3);
check(s.at(-1)?.audio?.v2?.share > 0.8, `AI mode again: AI track back (${((s.at(-1)?.audio?.v2?.share ?? 0) * 100).toFixed(0)}%)`);

console.log('\nSound effects off and on (recitation must stay)');
await fresh('quran recitation');
s = await sample(3);
const remOn = mean(s, (x) => x?.audio?.removed);
await setSettings({ keepSfx: false });
await sleep(9000); // the worker throws away its chunks and separates them again without the effects layer
s = await sample(5);
const remOff = mean(s, (x) => x?.audio?.removed);
const best = Math.max(...s.map((x) => x?.audio?.v2?.share ?? 0));
console.log(`  AI: removed ${(remOn * 100).toFixed(0)}% with effects kept, ${(remOff * 100).toFixed(0)}% with effects off; worker sfx=${s.at(-1)?.v2?.sfx}, AI track up to ${(best * 100).toFixed(0)}%`);
check(s.at(-1)?.v2?.sfx === 0, 'the AI worker got sfx 0');
check(best > 0.8, 'AI track back after re-separating');
check(remOff < 0.5, 'recitation still kept with effects off');
await setSettings({ mode: 'live' });
await sleep(2000);
s = await sample(3);
const remLive = mean(s, (x) => x?.audio?.removed);
console.log(`  Live, effects off: removed ${(remLive * 100).toFixed(0)}%`);
check(remLive < 0.5, 'Live mode keeps the recitation with effects off');
await setSettings({ mode: 'ai', keepSfx: true });
await sleep(2000);
s = await sample(1);
check(s[0]?.v2?.sfx === 1, 'effects back on: worker sfx=1');

console.log('\nRemoval off and on');
await fresh('ted talk');
await setSettings({ musicOn: false });
await sleep(1500);
s = await sample(1);
check(s[0]?.audio?.mode === 'off', 'off: sound plays untouched');
const ta = await now(); await sleep(3000); const tb = await now();
check(tb - ta > 2, 'video still plays with removal off');
await setSettings({ musicOn: true });
await sleep(1500);
s = await sample(1);
check(s[0]?.audio?.mode === 'worklet', 'on again');

console.log('\nBlur path (a fake "adult" score is injected; no adult content is used)');
await dismiss();
console.log('  blur before:', JSON.stringify((await status())?.blur));
const ms = await evalIso(`(async () => { const b = __sakina.blur; const t = performance.now();
  for (let i = 0; i < 5; i++) await b.mod.classify(b.canvas); return (performance.now() - t) / 5; })()`);
console.log(`  classifier time per frame: ${ms.toFixed(0)} ms (with the AI audio model also running)`);
check(ms < 150, 'classifier is fast enough to check several frames a second');
await evalIso(`(() => { const b = __sakina.blur; b._realClassify = b.mod.classify;
  b.mod = { ...b.mod, classify: async () => ({ Porn: 0.95, Hentai: 0, Sexy: 0.03, Neutral: 0.02, Drawing: 0 }) }; })()`);
let blurredNow = {};
for (let i = 0; i < 12 && !(blurredNow.cls && blurredNow.badge); i++) {
  await sleep(500);
  await dismiss();
  blurredNow = await yt.evaluate(`(() => { const v = document.querySelector('video.html5-main-video');
    const badge = document.querySelector('.sakina-badge'); return { cls: v.classList.contains('sakina-blur'), badge: !!badge && !badge.hidden }; })()`);
}
console.log('  blur after injecting:', JSON.stringify((await status())?.blur), JSON.stringify(blurredNow));
check(blurredNow.cls && blurredNow.badge, 'flagged frame blurs the player and shows the badge');
await yt.evaluate(`document.querySelector('.sakina-badge button').click()`);
await sleep(1200);
check(!(await yt.evaluate(`document.querySelector('video.html5-main-video').classList.contains('sakina-blur')`)), '"Show this video" lifts the blur');
await evalIso(`(() => { const b = __sakina.blur; b.allowedVideo = ''; b.mod = { ...b.mod, classify: async () => ({ Porn: 0.01, Hentai: 0, Sexy: 0, Neutral: 0.99, Drawing: 0 }) }; })()`);
await sleep(1500);
check(!(await yt.evaluate(`document.querySelector('video.html5-main-video').classList.contains('sakina-blur')`)), 'safe frames keep it unblurred');
await evalIso(`(() => { const b = __sakina.blur; b.mod = { ...b.mod, classify: b._realClassify }; })()`);

if (errors.length) console.log('\nextension errors/warnings:\n ', errors.slice(0, 8).join('\n  '));
check(errors.length === 0, 'no extension errors in the page');
await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
