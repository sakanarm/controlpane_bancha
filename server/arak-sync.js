// Keeps Arak in line with Bancha without anyone running a command: arak-push.js --apply runs when Bancha starts,
// when the desired file (or the connections file or manifest it relies on) changes, when an admin changes users,
// groups or roles in the Bancha database (poke), and every night as a reconcile.
//
// What is pushed: the desired file (connections, and any users or groups written there) plus, once the database is
// ready, the users and groups that hold Arak roles in it (server/arak-desired.js). The combined JSON goes to
// arak-push.js on stdin, so people's details are never written to a file.
//
// Env: ARAK_SYNC_FILE   desired file, relative to the repo (for example config/arak.json). Unset = off.
//      ARAK_SYNC_AT     nightly run, HH:MM server time (default 02:00)
//      ARAK_URL, ARAK_USER, ARAK_PASSWORD (or ARAK_TOKEN), as for arak-push.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const { arakDesired, markPushed } = require('./arak-desired');

const ROOT = path.resolve(__dirname, '..');
const PUSH = path.join(__dirname, 'arak-push.js');
const MANIFEST = path.join(ROOT, 'contracts', 'examples', 'arak.bancha-app.yaml');
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const WATCH_MS = 5000;     // stat polling survives git pull replacing the file, which fs.watch does not always
const SETTLE_MS = 3000;    // a pull touches several files, an admin may make several changes; push once after they settle
const RETRY_MS = 10 * 60 * 1000; // after a failed push, try again rather than wait for the night

const state = { enabled: false, reason: '', file: null, at: null, running: false, next: null, last: null, fromDb: null };
let pending = null, settle = null, retry = null, snapshot = null;

function log(line) { console.log('[arak-sync] ' + line); }

// The files a push reads. Re-read on every run, so a new connectionsFile is watched from then on.
function inputs(file) {
  const out = [file, MANIFEST];
  try { const w = JSON.parse(fs.readFileSync(file, 'utf8')); if (w.connectionsFile) out.push(path.resolve(ROOT, w.connectionsFile)); } catch { /* reported by the run */ }
  return out;
}
const watched = new Set();
function watch(file) {
  for (const f of inputs(file)) {
    if (watched.has(f)) continue;
    watched.add(f);
    fs.watchFile(f, { interval: WATCH_MS }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) changed(path.relative(ROOT, f).replace(/\\/g, '/')); }).unref?.();
  }
}
function changed(what) {
  clearTimeout(settle);
  settle = setTimeout(() => run('change: ' + what), SETTLE_MS);
}

// The file, plus the database's users and groups. A name in both: the file's entry wins, so a hand-written fix can override.
async function desired() {
  const want = JSON.parse(fs.readFileSync(state.file, 'utf8'));
  snapshot = null;
  if (!db.ready) { state.fromDb = null; return want; }
  const fromDb = await arakDesired();
  snapshot = fromDb.snapshot;
  const lc = s => (s || '').toLowerCase();
  const has = (list, key, v) => !!v && (list || []).some(x => lc(x[key]) === lc(v));
  want.groups = [...(want.groups || []), ...fromDb.groups.filter(g => !has(want.groups, 'name', g.name))];
  want.users = [...(want.users || []), ...fromDb.users.filter(u => !has(want.users, 'username', u.username) && !has(want.users, 'email', u.email))];
  state.fromDb = { users: fromDb.users.length, groups: fromDb.groups.length,
    revoke: fromDb.users.reduce((n, u) => n + (u.revoke || []).length + (u.leave || []).length, 0) };
  return want;
}

async function run(trigger) {
  if (state.running) { pending = trigger; return; }
  state.running = true;
  clearTimeout(retry);
  const startedAt = new Date().toISOString();
  log(`push (${trigger})`);
  let input;
  try { input = JSON.stringify(await desired()); } catch (e) {
    return finish(trigger, startedAt, { code: 1 }, '', 'error: cannot build what Arak should hold: ' + e.message);
  }
  const child = execFile(process.execPath, [PUSH, '-', '--apply'], { cwd: ROOT, env: process.env, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 << 20 },
    (err, stdout, stderr) => finish(trigger, startedAt, err, stdout, stderr));
  child.stdin.end(input);
}

function finish(trigger, startedAt, err, stdout, stderr) {
  const lines = (stdout + stderr).split('\n').filter(Boolean);
  // Step lines and results go to the log; the roles, attributes and groups each person holds in Arak stay out of it.
  for (const l of lines) if (!/^    (roles|attrs|groups):/.test(l)) log('  ' + l);
  const error = lines.find(l => l.startsWith('error: '));
  state.last = { trigger, startedAt, finishedAt: new Date().toISOString(), ok: !err,
    changes: lines.filter(l => l.startsWith('done ')).length,
    mismatches: lines.filter(l => /DOES NOT MATCH|NOT reachable|: missing$/.test(l)).length,
    error: error ? error.slice(7) : err ? (err.killed ? 'timed out' : 'exit ' + err.code) : null };
  log(`${state.last.ok ? 'ok' : 'FAILED'}: ${state.last.changes} change(s)${state.last.error ? ', ' + state.last.error : ''}`);
  // Only a clean push is remembered, so what Bancha takes back later is exactly what it is sure it gave.
  if (state.last.ok && !state.last.mismatches && snapshot)
    return markPushed(snapshot).catch(e => log('could not record the push: ' + e.message)).finally(() => next());
  next();
}

function next() {
  state.running = false;
  watch(state.file);
  if (pending) { const t = pending; pending = null; run(t); }
  else if (!state.last.ok) retry = setTimeout(() => run('retry after failure'), RETRY_MS).unref();
}

// Called after a committed change in the Bancha database. Changes close together become one push.
function poke(what) {
  if (state.enabled) changed('db: ' + what);
}

// Next HH:MM in server time, then every day after.
function nightly() {
  const [h, m] = state.at.split(':').map(Number);
  const next = new Date(); next.setHours(h, m, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  state.next = next.toISOString();
  setTimeout(() => { run('nightly reconcile'); nightly(); }, next - Date.now()).unref();
}

function start() {
  const f = process.env.ARAK_SYNC_FILE;
  const at = process.env.ARAK_SYNC_AT || '02:00';
  if (!f) { state.reason = 'ARAK_SYNC_FILE is not set'; return log('off: ' + state.reason); }
  if (!process.env.ARAK_TOKEN && !(process.env.ARAK_USER && process.env.ARAK_PASSWORD)) { state.reason = 'no Arak login in .env (ARAK_USER, ARAK_PASSWORD)'; return log('off: ' + state.reason); }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) { state.reason = `ARAK_SYNC_AT ${at} is not HH:MM`; return log('off: ' + state.reason); }
  state.file = path.resolve(ROOT, f);
  if (!fs.existsSync(state.file)) { state.reason = `${f} not found`; return log('off: ' + state.reason); }
  Object.assign(state, { enabled: true, at, reason: '' });
  log(`on: ${f} as ${process.env.ARAK_USER || 'token'} to ${process.env.ARAK_URL || 'default URL'}, nightly at ${at}`);
  watch(state.file);
  nightly();
  run('start');
}

// What /api/arak-sync shows. No secrets; step lines stay in the pm2 log.
function status() {
  return { ...state, file: state.file && path.relative(ROOT, state.file).replace(/\\/g, '/'), watching: [...watched].map(f => path.relative(ROOT, f).replace(/\\/g, '/')) };
}

module.exports = { start, status, poke };
