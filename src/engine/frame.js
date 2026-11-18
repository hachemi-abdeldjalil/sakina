// Hidden extension iframe inside the YouTube page. Its only job: start the separation worker
// (which needs the extension's origin for WebAssembly and the model files) and hand it the private
// MessagePort the content script sent, so the two talk directly with zero-copy transfers.
const ALLOWED = new Set(['https://www.youtube.com', 'https://m.youtube.com']);
let started = false;

window.addEventListener('message', (e) => {
  if (!ALLOWED.has(e.origin) || started) return;
  if (!e.data || e.data.type !== 'sakina-connect' || !e.ports[0]) return;
  started = true;
  // (If the worker fails to start, the content script's "ready" timeout falls back to live mode.)
  const worker = new Worker('dist/engine-worker.js', { type: 'module' });
  worker.postMessage({ type: 'port' }, [e.ports[0]]);
});
