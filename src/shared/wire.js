// Messages between a YouTube tab and the engine in the offscreen document travel over chrome.runtime
// ports, which carry JSON only. Typed-array fields (captured bytes, live snippets, separated chunks)
// travel as base64 strings and come back as the same typed array.
const TYPES = { Uint8Array, Int16Array, Float32Array };

export function toBase64(u8) {
  if (typeof u8.toBase64 === 'function') return u8.toBase64();
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(str);
  const s = atob(str), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/** Message → JSON-safe message (typed-array fields become { $b64, $t }). */
export function pack(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  let out = null;
  for (const [k, v] of Object.entries(msg)) {
    if (!ArrayBuffer.isView(v) || !TYPES[v.constructor.name]) continue;
    out ??= { ...msg };
    out[k] = { $b64: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), $t: v.constructor.name };
  }
  return out || msg;
}

/** The reverse of pack. Returns { msg, transfer } (the new buffers, ready to move to a worker). */
export function unpack(msg) {
  const transfer = [];
  if (!msg || typeof msg !== 'object') return { msg, transfer };
  let out = null;
  for (const [k, v] of Object.entries(msg)) {
    if (!v || typeof v !== 'object' || typeof v.$b64 !== 'string' || !TYPES[v.$t]) continue;
    out ??= { ...msg };
    const u8 = fromBase64(v.$b64), T = TYPES[v.$t];
    out[k] = T === Uint8Array ? u8 : new T(u8.buffer, u8.byteOffset, u8.byteLength / T.BYTES_PER_ELEMENT);
    transfer.push(out[k].buffer);
  }
  return { msg: out || msg, transfer };
}
