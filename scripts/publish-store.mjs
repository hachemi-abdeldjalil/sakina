#!/usr/bin/env node
// One-command Chrome Web Store updates for Sakina (Chrome Web Store API v2).
//
//   node scripts/publish-store.mjs setup          once: saves API credentials in the macOS Keychain
//   node scripts/publish-store.mjs status         shows what the store has (versions, review state)
//   node scripts/publish-store.mjs bump [patch|minor|major]   raises the version in manifest + package.json
//   node scripts/publish-store.mjs                builds the zip, uploads it and submits it for review
//   node scripts/publish-store.mjs --upload-only  uploads without submitting (submit later in the dashboard)
//
// The API can only update an item that already exists (Sakina's was created in the dashboard).
// Secrets never touch this folder: client secret and refresh token live in the Keychain under the
// service below, shared by every extension published from the same Google account.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEM_ID = 'gjiadlibjmopbfcglkaolniphiojkhna';
const KEYCHAIN_SERVICE = 'chrome-web-store';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'static/manifest.json');
const packagePath = join(root, 'package.json');

const die = (msg) => { console.error(msg); process.exit(1); };

// --- Keychain ---------------------------------------------------------------------------------
function keychainGet(name) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return die(`Missing '${name}' in the Keychain (service '${KEYCHAIN_SERVICE}'). Run: node scripts/publish-store.mjs setup`);
  }
}
function keychainSet(name, value) {
  execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', value], { stdio: 'ignore' });
}

// --- Prompts ----------------------------------------------------------------------------------
function ask(question, { hidden = false, fallback = '' } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim() || fallback); });
  });
}

// --- OAuth (desktop app, loopback redirect) ----------------------------------------------------
async function postForm(url, fields) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(fields) });
  const data = await res.json();
  if (!res.ok) die(`${url} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function signIn(clientId, clientSecret) {
  const state = randomBytes(16).toString('base64url');
  let resolveAnswer;
  const answer = new Promise((r) => { resolveAnswer = r; });
  const server = createServer((req, res) => {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Done. You can close this tab and go back to the terminal.');
    if (q.get('state') === state) resolveAnswer(Object.fromEntries(q));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  console.log('\nSign in with the Google account that owns Sakina in the Chrome Web Store.');
  console.log(`If the browser doesn't open, visit:\n${url}\n`);
  try { execFileSync('open', [url]); } catch {}
  const a = await answer;
  server.close();
  if (a.error) die(`Google sign-in failed: ${a.error}`);
  const tokens = await postForm('https://oauth2.googleapis.com/token', {
    code: a.code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) die("Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and run setup again.");
  return tokens.refresh_token;
}

async function accessToken() {
  const t = await postForm('https://oauth2.googleapis.com/token', {
    client_id: keychainGet('client_id'), client_secret: keychainGet('client_secret'),
    refresh_token: keychainGet('refresh_token'), grant_type: 'refresh_token',
  });
  return t.access_token;
}

// --- API --------------------------------------------------------------------------------------
const itemPath = () => `/v2/publishers/${keychainGet('publisher_id')}/items/${ITEM_ID}`;

async function call(method, path, token, body, contentType) {
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(API + path, { method, headers, body });
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} failed (${res.status}):\n${text}`);
  return text ? JSON.parse(text) : {};
}

const fetchStatus = (token) => call('GET', itemPath() + ':fetchStatus', token);

export function versionsOf(status) {
  const out = {};
  for (const [key, label] of [['publishedItemRevisionStatus', 'published'], ['submittedItemRevisionStatus', 'submitted']]) {
    const r = status[key];
    if (r) out[label] = { state: r.state, versions: (r.distributionChannels || []).map((c) => `${c.crxVersion} (${c.deployPercentage ?? 100}%)`) };
  }
  return out;
}

function printStatus(status) {
  const v = versionsOf(status);
  console.log(`Item ${status.itemId || ITEM_ID}`);
  console.log(`  published: ${v.published ? `${v.published.state} ${v.published.versions.join(', ')}` : 'not published yet'}`);
  console.log(`  submitted: ${v.submitted ? `${v.submitted.state} ${v.submitted.versions.join(', ')}` : 'nothing waiting'}`);
  if (status.lastAsyncUploadState) console.log(`  last upload: ${status.lastAsyncUploadState}`);
  if (status.takenDown) console.log('  TAKEN DOWN by the store');
  if (status.warned) console.log('  the store has issued a warning: check the dashboard');
}

// --- Versions ---------------------------------------------------------------------------------
const parseV = (s) => String(s).split('.').map((n) => parseInt(n, 10) || 0);
export function cmpV(a, b) {
  const x = parseV(a), y = parseV(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
export function bumpVersion(v, part = 'patch') {
  const [maj, min, pat] = [...parseV(v), 0, 0, 0];
  if (part === 'major') return `${maj + 1}.0.0`;
  if (part === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function bump(part) {
  if (!['patch', 'minor', 'major'].includes(part)) die('bump takes patch, minor or major');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const p = JSON.parse(readFileSync(packagePath, 'utf8'));
  const next = bumpVersion(m.version, part);
  m.version = next; p.version = next;
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
  writeFileSync(packagePath, JSON.stringify(p, null, 2) + '\n');
  console.log(`version ${next} (static/manifest.json and package.json)`);
}

// --- Commands ---------------------------------------------------------------------------------
async function setup() {
  console.log('One-time setup. You need a Google Cloud OAuth client of type "Desktop app" with the');
  console.log('Chrome Web Store API enabled (steps: store/CHROME_WEB_STORE.md, "Updates from the terminal").\n');
  const clientId = await ask('Client ID: ');
  const clientSecret = await ask('Client secret (hidden): ', { hidden: true });
  const publisherId = await ask('Publisher ID (the long ID after /devconsole/ in the dashboard address): ');
  if (!clientId || !clientSecret || !publisherId) die('Client ID, secret and publisher ID are all needed.');
  const refreshToken = await signIn(clientId, clientSecret);
  for (const [k, v] of [['client_id', clientId], ['client_secret', clientSecret], ['publisher_id', publisherId], ['refresh_token', refreshToken]]) keychainSet(k, v);
  console.log(`\nSaved to the Keychain (service '${KEYCHAIN_SERVICE}'). Checking access…\n`);
  printStatus(await fetchStatus(await accessToken()));
}

async function publish({ submit }) {
  const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  const token = await accessToken();
  const before = await fetchStatus(token);
  const v = versionsOf(before);
  if (v.submitted && v.submitted.state === 'PENDING_REVIEW') {
    die(`Version ${v.submitted.versions.join(', ')} is still in review. Wait for the result, or cancel the review in the dashboard, before uploading another one.`);
  }
  const seen = [...(v.published?.versions || []), ...(v.submitted?.versions || [])].map((s) => s.split(' ')[0]);
  const newest = seen.sort(cmpV).at(-1);
  if (newest && cmpV(version, newest) <= 0) die(`The store already has ${newest}; this build is ${version}. Raise it first: node scripts/publish-store.mjs bump`);

  console.log(`Building Sakina ${version}…`);
  execFileSync('npm', ['run', 'zip', '--silent'], { cwd: root, stdio: 'inherit' });
  const zip = join(root, `Sakina-${version}.zip`);
  const bytes = readFileSync(zip);
  console.log(`Uploading ${(bytes.length / 1048576).toFixed(1)} MB…`);
  const up = await call('POST', '/upload' + itemPath() + ':upload', token, bytes, 'application/zip');
  let state = up.uploadState;
  while (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') {
    await new Promise((r) => setTimeout(r, 3000));
    state = (await fetchStatus(token)).lastAsyncUploadState || state;
  }
  if (state !== 'SUCCEEDED') die(`Upload did not succeed (${state}):\n${JSON.stringify(up, null, 2)}`);
  console.log(`Uploaded ${up.crxVersion || version}.`);
  if (!submit) { console.log('Not submitted (--upload-only). Submit it from the dashboard when ready.'); return; }
  console.log('Submitting for review…');
  const res = await call('POST', itemPath() + ':publish', token, JSON.stringify({}), 'application/json');
  console.log(`Submission state: ${res.state}`);
  for (const w of res.warningInfo?.warnings || []) console.log(`  warning: ${w.reason}: ${w.description}`);
  printStatus(await fetchStatus(token));
}

const [cmd = 'publish', arg] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'setup') await setup();
  else if (cmd === 'status') printStatus(await fetchStatus(await accessToken()));
  else if (cmd === 'bump') bump(arg || 'patch');
  else if (cmd === 'publish' || cmd === '--upload-only') await publish({ submit: cmd !== '--upload-only' });
  else die(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
