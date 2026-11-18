import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { WebmOpusDemuxer, opusPacketDurationUs } from '../src/sep/webm.js';

const file = readFileSync(new URL('./fixtures/voice.webm', import.meta.url));

function demux(chunks) {
  const cfgs = [], pkts = [], bad = [];
  const d = new WebmOpusDemuxer({ onConfig: (c) => cfgs.push(c), onPacket: (p) => pkts.push(p), onUnsupported: (r) => bad.push(r) });
  for (const c of chunks) d.push(c);
  return { cfgs, pkts, bad };
}

function randomChunks(buf, seed) {
  let s = seed, pos = 0;
  const out = [];
  while (pos < buf.length) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = 1 + (s % 5000);
    out.push(new Uint8Array(buf.subarray(pos, pos + n)));
    pos += n;
  }
  return out;
}

test('whole file: Opus config and every packet (ffprobe counts 404)', () => {
  const { cfgs, pkts, bad } = demux([new Uint8Array(file)]);
  assert.equal(bad.length, 0);
  assert.equal(cfgs.length, 1);
  assert.equal(cfgs[0].codec, 'opus');
  assert.equal(cfgs[0].sampleRate, 48000);
  assert.equal(cfgs[0].numberOfChannels, 2);
  assert.ok(cfgs[0].description && new TextDecoder().decode(cfgs[0].description.subarray(0, 8)) === 'OpusHead');
  assert.equal(pkts.length, 404);
  for (let i = 1; i < pkts.length; i++) assert.ok(pkts[i].timestampUs > pkts[i - 1].timestampUs, 'timestamps increase');
  const last = pkts.at(-1);
  assert.ok(Math.abs((last.timestampUs + last.durationUs) / 1e6 - 8.07) < 0.05, `ends at ${(last.timestampUs / 1e6).toFixed(3)} s`);
});

test('same result when fed in random small pieces (elements split across appends)', () => {
  const whole = demux([new Uint8Array(file)]).pkts;
  for (const seed of [1, 7, 99]) {
    const pieces = demux(randomChunks(file, seed)).pkts;
    assert.equal(pieces.length, whole.length);
    for (let i = 0; i < whole.length; i++) {
      assert.equal(pieces[i].timestampUs, whole[i].timestampUs);
      assert.deepEqual(Array.from(pieces[i].data), Array.from(whole[i].data));
    }
  }
});

test('a second stream (new EBML header) starts over', () => {
  const { cfgs, pkts } = demux([new Uint8Array(file), new Uint8Array(file)]);
  assert.equal(cfgs.length, 2);
  assert.equal(pkts.length, 808);
  assert.ok(pkts[404].timestampUs < pkts[403].timestampUs, 'second stream restarts its clock');
});

test('Opus packet durations from the TOC byte', () => {
  assert.equal(opusPacketDurationUs(new Uint8Array([0xfc])), 20000);       // CELT 20 ms, 1 frame
  assert.equal(opusPacketDurationUs(new Uint8Array([0xfd])), 40000);       // CELT 20 ms, 2 frames
  assert.equal(opusPacketDurationUs(new Uint8Array([0x08])), 20000);       // SILK NB 20 ms
  assert.equal(opusPacketDurationUs(new Uint8Array([0xf3, 0x03])), 30000); // CELT 10 ms (config 30), code 3, 3 frames
});

// Real YouTube bytes are not committed (copyright); run when a local capture is present.
const yt = process.env.SAKINA_YT_APPENDS;
test('real YouTube appends (local capture only)', { skip: !yt || !existsSync(yt) }, () => {
  const appends = JSON.parse(readFileSync(yt, 'utf8')).map((a) => new Uint8Array(a));
  const { cfgs, pkts, bad } = demux(appends);
  const streams = [];
  let cur = null;
  for (const p of pkts) {
    if (!cur || p.timestampUs < cur.last) { cur = { first: p.timestampUs, last: p.timestampUs, n: 0 }; streams.push(cur); }
    cur.last = p.timestampUs; cur.n++;
  }
  console.log(`  ${appends.length} appends → ${cfgs.length} config(s), ${pkts.length} packets; streams: ${streams.map((s) => `${(s.first / 1e6).toFixed(1)}–${(s.last / 1e6).toFixed(1)} s (${s.n})`).join(', ')}`);
  assert.equal(bad.length, 0);
  assert.ok(cfgs.length >= 1 && pkts.length > 1000);
});
