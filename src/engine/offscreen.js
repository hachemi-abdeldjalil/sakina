// The offscreen document: one AI engine worker per YouTube tab that connects. It relays messages
// between the tab's chrome.runtime port (JSON, see shared/wire.js) and the worker (zero-copy).
import { pack, unpack } from '../shared/wire.js';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sakina-engine' || !port.sender?.tab) return;
  let open = true;
  const toTab = (msg) => { if (open) try { port.postMessage(pack(msg)); } catch { open = false; } };
  const worker = new Worker('dist/engine-worker.js', { type: 'module' });
  const ch = new MessageChannel();
  worker.onerror = (e) => toTab({ type: 'error', error: `engine worker: ${e.message || 'failed to start'}` });
  ch.port1.onmessage = (m) => toTab(m.data);
  worker.postMessage({ type: 'port' }, [ch.port2]);
  port.onMessage.addListener((raw) => {
    const { msg, transfer } = unpack(raw);
    ch.port1.postMessage(msg, transfer);
  });
  port.onDisconnect.addListener(() => {
    open = false;
    worker.terminate(); // the tab closed or navigated away: free the model's memory and threads
    ch.port1.close();
  });
  toTab({ type: 'hello', isolated: self.crossOriginIsolated });
});
