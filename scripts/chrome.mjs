// Launches Google Chrome with a throwaway profile and loads build/ as an unpacked extension.
// (--load-extension is ignored by current Chrome, so we use the DevTools protocol over a pipe.)
//
//   node scripts/chrome.mjs [url]     opens Chrome for manual testing; Ctrl+C to quit
//   import { launch } from './chrome.mjs'   used by the end-to-end test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function launch({ extraArgs = [], profileDir, extension = true } = {}) {
  const profile = profileDir || mkdtempSync(join(tmpdir(), 'sakina-chrome-'));
  const proc = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

  const toChrome = proc.stdio[3], fromChrome = proc.stdio[4];
  let nextId = 1, buf = '';
  const pending = new Map();
  const listeners = new Set();
  fromChrome.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  proc.stderr.on('data', () => {});

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });

  // extension: false gives the same automated Chrome without Sakina (to tell its bugs from YouTube's).
  const extensionId = extension ? (await send('Extensions.loadUnpacked', { path: join(root, 'build') })).id : null;

  async function open(url) {
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // Wait until the requested page (not the initial about:blank) has loaded.
    for (let i = 0; i < 100; i++) {
      try {
        const ok = await evaluate(`document.readyState === 'complete' && (${JSON.stringify(url)} === 'about:blank' || location.href !== 'about:blank')`);
        if (ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return { targetId, sessionId, evaluate, send: (m, p) => send(m, p, sessionId) };
  }

  async function close() {
    try { await send('Browser.close'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    proc.kill();
    if (!profileDir) rmSync(profile, { recursive: true, force: true });
  }

  return { extensionId, send, open, close, onEvent: (f) => listeners.add(f), proc };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] || 'https://www.youtube.com/';
  const b = await launch();
  console.log(`Sakina loaded (extension id ${b.extensionId}). Opening ${url}. Ctrl+C to quit.`);
  await b.open(url);
  process.on('SIGINT', async () => { await b.close(); process.exit(0); });
  b.proc.on('exit', () => process.exit(0));
}
