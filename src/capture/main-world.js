// Runs in the PAGE's JavaScript world (manifest "world": "MAIN", at document_start), before YouTube's
// player. It copies the Opus audio bytes YouTube appends to its Media Source buffers — usually 30–100 s
// ahead of playback — and hands the copies to Sakina's content script. Playback itself is untouched:
// YouTube's own call always goes through unchanged.
(() => {
  if (window.__sakinaCapture) return;
  window.__sakinaCapture = true;
  const TAG = '__sakina_mse__';
  const ids = new WeakMap();
  let nextId = 1;
  const post = (msg, transfer) => {
    try { window.postMessage({ [TAG]: 1, ...msg }, location.origin, transfer || []); } catch {}
  };

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.call(this, mime);
    try {
      const m = String(mime || '');
      if (/^audio\//i.test(m)) {
        if (/webm/i.test(m) && /opus/i.test(m)) {
          const id = nextId++;
          ids.set(sb, id);
          post({ kind: 'new', id, mime: m });
        } else {
          post({ kind: 'unsupported', mime: m });
        }
      }
    } catch {}
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const id = ids.get(this);
    if (id) {
      try {
        const u8 = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        const copy = u8.slice();
        post({ kind: 'append', id, bytes: copy }, [copy.buffer]);
      } catch {}
    }
    return appendBuffer.call(this, data);
  };
})();
