// Sign-in for the Bancha console until Entra is wired up: the username and password are checked by Arak
// (POST /v1/auth/login) and only Arak PLATFORM_ADMINs get in. Bancha keeps no password and drops Arak's token;
// it keeps a random session id in an HttpOnly cookie and the signed-in user in memory (a restart signs everyone out).
//
// Env: BANCHA_AUTH  arak (default) or off (local work on the prototype only; every API is then open)
//      ARAK_URL     as for arak-push.js
'use strict';
const crypto = require('crypto');

const MODE = process.env.BANCHA_AUTH === 'off' ? 'off' : 'arak';
const BASE = (process.env.ARAK_URL || 'http://127.0.0.1:8090/api').replace(/\/$/, '');
const ROLE = 'PLATFORM_ADMIN';
const COOKIE = 'bancha_sid';
const TTL_MS = 8 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000, FAIL_MAX = 10;

const sessions = new Map();   // id -> { user, expires }
const fails = new Map();      // ip -> [timestamps]

const cookieOf = req => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === COOKIE)?.[1];
const ipOf = req => req.socket.remoteAddress || '';

function current(req) {
  if (MODE === 'off') return { username: 'local', displayName: 'Local (auth off)', email: '', roles: [ROLE] };
  const id = cookieOf(req), s = id && sessions.get(id);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(id); return null; }
  return s.user;
}

// Same-origin check for writes. With SameSite=Strict it is belt and braces against another site posting here.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

async function readJson(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Error('body too large'); }
  return body ? JSON.parse(body) : {};
}

function tooMany(ip) {
  const now = Date.now(), list = (fails.get(ip) || []).filter(t => now - t < FAIL_WINDOW_MS);
  fails.set(ip, list);
  return list.length >= FAIL_MAX;
}

// Returns [status, body, headers]. Never logs or returns the password.
async function login(req) {
  if (MODE === 'off') return [200, { user: current(req) }];
  if (!sameOrigin(req)) return [403, { error: 'Cross-site sign-in is not allowed.' }];
  const ip = ipOf(req);
  if (tooMany(ip)) return [429, { error: 'Too many failed sign-ins. Try again in 15 minutes.' }];
  let username, password;
  try { ({ username, password } = await readJson(req)); } catch { return [400, { error: 'Bad request.' }]; }
  username = String(username || '').trim();
  if (!username || !password) return [400, { error: 'Enter your username and password.' }];
  const fail = (status, error, why) => { fails.get(ip).push(Date.now()); console.log(`[auth] sign-in refused: ${username} from ${ip} (${why})`); return [status, { error }]; };
  if (process.env.ARAK_USER && username.toLowerCase() === process.env.ARAK_USER.toLowerCase())
    return fail(403, 'This is a service account. It cannot sign in to the console.', 'service account');

  let r;
  try {
    r = await fetch(BASE + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: String(password) }), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error('[auth] Arak not reachable:', e.message);
    return [503, { error: 'Arak is not reachable, so Bancha cannot check your password right now.' }];
  }
  if (r.status === 401 || r.status === 403 || r.status === 400) return fail(401, 'Username or password is incorrect.', 'Arak said ' + r.status);
  if (!r.ok) { console.error('[auth] Arak login answered', r.status); return [502, { error: `Arak answered ${r.status}. Try again later.` }]; }
  const d = await r.json();
  const u = d.user || {};
  if (d.mustChangePassword) return fail(403, 'Arak asks you to change your password first. Sign in to Arak, change it, then come back.', 'must change password');
  if (!(u.roles || []).includes(ROLE)) return fail(403, 'Only Arak platform admins can open Bancha for now.', 'not ' + ROLE);

  const user = { username: u.username || username, displayName: u.displayName || u.username || username, email: u.email || '', roles: u.roles, source: u.source || '' };
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { user, expires: Date.now() + TTL_MS });
  fails.delete(ip);
  console.log(`[auth] signed in: ${user.username} from ${ip}`);
  // No Secure flag: prod is plain http on an IP for now (see HANDOFF). HttpOnly and SameSite=Strict still apply.
  return [200, { user }, { 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}` }];
}

function logout(req) {
  const id = cookieOf(req), s = id && sessions.get(id);
  if (s) { sessions.delete(id); console.log(`[auth] signed out: ${s.user.username}`); }
  return [200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }];
}

setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k); }, 10 * 60 * 1000).unref();

module.exports = { MODE, current, login, logout, sameOrigin };
