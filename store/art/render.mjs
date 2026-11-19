// Renders the Chrome Web Store images into store/images/: node store/art/render.mjs
import { launch } from '../../scripts/chrome.mjs';
import { writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const b = await launch({ extension: false, extraArgs: ['--window-position=3000,3000', '--allow-file-access-from-files'] });
const pages = [
  ['gallery-1', 1280, 800, 'screenshot-1-1280x800'],
  ['gallery-2', 1280, 800, 'screenshot-2-1280x800'],
  ['gallery-3', 1280, 800, 'screenshot-3-1280x800'],
  ['gallery-4', 1280, 800, 'screenshot-4-1280x800'],
  ['gallery-5', 1280, 800, 'screenshot-5-1280x800'],
  ['promo', 440, 280, 'promo-440x280'],
  ['marquee', 1400, 560, 'marquee-1400x560'],
];
for (const [name, w, h, out] of pages) {
  const p = await b.open(`file://${dir}${name}.html`);
  await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 1500));
  await p.evaluate('document.fonts.ready.then(() => true)');
  // Chrome Web Store screenshots must be 24-bit PNG or JPEG without transparency: PNG of an opaque page.
  const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(`${dir}../images/${out}.png`, Buffer.from(shot.data, 'base64'));
  console.log('wrote images/' + out + '.png');
}
await b.close();
