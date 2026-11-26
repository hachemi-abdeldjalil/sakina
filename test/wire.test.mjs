// The offscreen engine's message codec: typed arrays survive a JSON trip exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack, toBase64, fromBase64 } from '../src/shared/wire.js';

const jsonTrip = (msg) => JSON.parse(JSON.stringify(pack(msg)));

test('typed arrays survive a JSON round trip, other fields unchanged', () => {
  const L = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 7) * 0.9);
  const R = Float32Array.from({ length: 48000 }, (_, i) => (i % 13) / 13 - 0.5);
  const bytes = Uint8Array.from({ length: 70001 }, (_, i) => (i * 31) & 255);
  const { msg, transfer } = unpack(jsonTrip({ type: 'chunk', start: 12.5, L, R, share: { music: 0.4 } }));
  assert.equal(msg.type, 'chunk');
  assert.equal(msg.start, 12.5);
  assert.deepEqual(msg.share, { music: 0.4 });
  assert.ok(msg.L instanceof Float32Array && msg.R instanceof Float32Array);
  assert.deepEqual(msg.L, L);
  assert.deepEqual(msg.R, R);
  assert.equal(transfer.length, 2);
  const b = unpack(jsonTrip({ type: 'append', id: 3, bytes })).msg;
  assert.ok(b.bytes instanceof Uint8Array);
  assert.deepEqual(b.bytes, bytes);
});

test('a view into a larger buffer sends only its own bytes', () => {
  const big = new Float32Array(100).map((_, i) => i);
  const view = big.subarray(10, 20);
  const { msg } = unpack(jsonTrip({ type: 'align', snippet: view }));
  assert.deepEqual([...msg.snippet], [...view]);
});

test('messages without binary data pass through untouched', () => {
  const m = { type: 'playhead', t: 3, playing: true };
  assert.equal(pack(m), m);
  assert.equal(unpack(m).msg, m);
});

test('the fallback base64 code matches the built-in one', () => {
  const u8 = Uint8Array.from({ length: 100003 }, (_, i) => (i * 7919) & 255);
  const native = typeof u8.toBase64 === 'function';
  const saved = [Uint8Array.prototype.toBase64, Uint8Array.fromBase64];
  try {
    const a = toBase64(u8);
    delete Uint8Array.prototype.toBase64; delete Uint8Array.fromBase64;
    const b = toBase64(u8);
    assert.equal(a, b);
    assert.deepEqual(fromBase64(b), u8);
    assert.equal(b, Buffer.from(u8).toString('base64'));
  } finally {
    if (native) { Uint8Array.prototype.toBase64 = saved[0]; Uint8Array.fromBase64 = saved[1]; }
  }
});
