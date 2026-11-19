import { launch } from '../../scripts/chrome.mjs';
import { writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const b = await launch({ extraArgs: ['--window-position=3000,3000', '--allow-file-access-from-files'] });
for (const [name, w, h] of [['shot1', 1280, 800], ['shot3', 1280, 800], ['promo', 440, 280]]) {
  const p = await b.open(`file://${dir}${name}.html`);
  await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 2500));
  await p.evaluate('document.fonts.ready.then(() => true)');
  const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  const out = `${dir}../images/${name === 'promo' ? 'promo-440x280' : name + '-1280x800'}.png`;
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('wrote', out.split('/').slice(-2).join('/'));
}
await b.close();
