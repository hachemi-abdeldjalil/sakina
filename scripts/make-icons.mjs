// Draws the Sakina icon: a deep green tile with a paper-coloured music note crossed out in red.
//   node scripts/make-icons.mjs            writes static/icons/icon{16,32,48,128}.png and store/images/icon-128x128.png
//   node scripts/make-icons.mjs <dir>      writes the PNGs and icon.svg into <dir> instead (for previews)
import { launch } from './chrome.mjs';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..');
export const COLORS = { tile: '#1e4b40', note: '#f4eee2', slash: '#e2493d' };

// Everything is drawn on a 96 x 96 tile: two beamed notes (as in the logo) under a red slash.
const NOTES = `
  <ellipse cx="30" cy="66" rx="12.5" ry="9.5" transform="rotate(-20 30 66)"/>
  <ellipse cx="62" cy="60" rx="12.5" ry="9.5" transform="rotate(-20 62 60)"/>
  <rect x="36.25" y="27" width="5.5" height="38"/>
  <rect x="68.25" y="21" width="5.5" height="38"/>
  <polygon points="36.25,27 73.75,20 73.75,32 36.25,39"/>`;

// The slash gets heavier as the icon gets smaller, so it still reads at 16 px.
export function iconSVG(px, { pad = 0 } = {}) {
  const v = 96 + 2 * pad;
  const red = px <= 16 ? 10 : px <= 32 ? 8.5 : 7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${-pad} ${-pad} ${v} ${v}">
  <rect width="96" height="96" rx="21" fill="${COLORS.tile}"/>
  <g fill="${COLORS.note}" transform="translate(2 1)">${NOTES}</g>
  <line x1="17" y1="81" x2="81" y2="15" stroke="${COLORS.slash}" stroke-width="${red}" stroke-linecap="round"/>
</svg>`;
}

// Chrome Web Store: the 128 icon is 96 x 96 artwork with 16 px of transparent padding on each side.
const SIZES = [
  { px: 16, pad: 0 },
  { px: 32, pad: 0 },
  { px: 48, pad: 2 },
  { px: 128, pad: 16 },
];

async function render(b, svg, px) {
  const p = await b.open('about:blank');
  await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await p.send('Emulation.setDeviceMetricsOverride', { width: px, height: px, deviceScaleFactor: 1, mobile: false });
  await p.evaluate(`document.documentElement.innerHTML = ${JSON.stringify(
    `<head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body>`)}; true`);
  await new Promise((r) => setTimeout(r, 200));
  const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: px, height: px, scale: 1 } });
  return Buffer.from(shot.data, 'base64');
}

const out = process.argv[2];
const dst = out || join(root, 'static', 'icons');
mkdirSync(dst, { recursive: true });
const b = await launch({ extension: false, extraArgs: ['--window-position=3000,3000'] });
try {
  for (const s of SIZES) {
    writeFileSync(join(dst, `icon${s.px}.png`), await render(b, iconSVG(s.px, s), s.px));
    console.log(`wrote icon${s.px}.png`);
  }
} finally {
  await b.close();
}
writeFileSync(join(out || join(root, 'store', 'art'), 'icon.svg'), iconSVG(512) + '\n');
if (!out) {
  copyFileSync(join(dst, 'icon128.png'), join(root, 'store', 'images', 'icon-128x128.png'));
  console.log('copied store/images/icon-128x128.png');
}
