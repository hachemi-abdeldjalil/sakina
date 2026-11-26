// Background service worker. Its only job: open the offscreen document that hosts the AI engine
// when a YouTube tab asks for it. That document is an extension page of its own (not an iframe inside
// YouTube), so Chrome gives it cross-origin isolation, and the model can use several threads.
let creating = null;

async function ensureEngine() {
  const have = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (have.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Runs the music-removal model for YouTube tabs, on several threads.',
  }).finally(() => { creating = null; });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'sakina:engine') return;
  ensureEngine().then(
    () => reply({ ok: true }),
    (err) => reply({ ok: false, error: String(err?.message || err) }),
  );
  return true; // the reply comes later
});
