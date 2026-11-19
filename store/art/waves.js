// Waveform lanes drawn as bars, from a fixed seed so every render is identical.
function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }
const env = {
  music: (t, r) => 0.55 + 0.25 * Math.sin(t * 9) * Math.sin(t * 2.3) + 0.15 * r(),
  voice: (t, r) => { const syl = Math.max(0, Math.sin(t * 23) * Math.sin(t * 5.1 + 1)); return t % 0.33 > 0.27 ? 0.04 : 0.15 + 0.8 * syl * (0.7 + 0.3 * r()); },
  effects: (t, r) => { const p = [0.12, 0.41, 0.63, 0.88]; let v = 0.03; for (const c of p) { const d = t - c; if (d >= 0 && d < 0.05) v = Math.max(v, (1 - d / 0.05) * (0.7 + 0.3 * r())); } return v; },
};
for (const el of document.querySelectorAll('[data-wave]')) {
  const kind = el.dataset.wave, color = el.dataset.color, W = el.clientWidth, H = el.clientHeight;
  const r = rng(kind.length * 977 + 13), bar = 3, gap = 2, n = Math.floor(W / (bar + gap));
  let rects = '';
  for (let i = 0; i < n; i++) {
    const a = Math.min(1, env[kind](i / n, r)), h = Math.max(2, a * H);
    rects += `<rect x="${i * (bar + gap)}" y="${(H - h) / 2}" width="${bar}" height="${h}" rx="1.5"/>`;
  }
  el.innerHTML = `<svg width="${W}" height="${H}" fill="${color}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}
