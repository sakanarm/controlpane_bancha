#!/usr/bin/env node
// Creates the Arak account Bancha signs in with (bancha-sync, a SERVICE with PLATFORM_ADMIN), so Arak's audit names
// Bancha rather than a person, and writes its login to Bancha's .env. Run once per Arak, on the host where Bancha runs.
//
//   printf '%s\n' '<arak admin password>' | ARAK_ADMIN_USER=admin node server/arak-sync-account.js [--rotate]
//
// The admin password is read from stdin and used only for this run. The account's password is random, is changed once
// so Arak's must-change flag clears, and goes only to .env (mode 600). Nothing secret is printed.
// --rotate gives an existing bancha-sync a new password the same way.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = process.env.BANCHA_ENV || path.join(__dirname, '..', '.env');
const BASE = (process.env.ARAK_URL || 'http://127.0.0.1:8090/api').replace(/\/$/, '');
const NAME = 'bancha-sync';
const rotate = process.argv.includes('--rotate');

async function call(method, url, body, token) {
  const res = await fetch(BASE + url, { method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const login = (username, password) => call('POST', '/v1/auth/login', { username, password });
const newPassword = () => crypto.randomBytes(30).toString('base64url');

// Sets KEY=value lines in .env, replacing any already there, and keeps the file private.
function writeEnv(values) {
  let lines = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex(l => l.startsWith(k + '='));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${k}=${v}`);
  }
  fs.writeFileSync(ENV, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
}

async function main() {
  const adminPassword = fs.readFileSync(0, 'utf8').split('\n')[0];
  if (!adminPassword) throw new Error('send the Arak admin password on stdin');
  const admin = await login(process.env.ARAK_ADMIN_USER || 'admin', adminPassword);
  if (admin.mustChangePassword) throw new Error('the admin account must change its password in Arak first');
  const t = admin.accessToken;

  const found = (await call('GET', '/v1/principals?' + new URLSearchParams({ q: NAME, limit: 50 }), null, t))
    .find(p => p.source === 'local' && p.username === NAME);
  const first = newPassword();
  if (found && !rotate) throw new Error(`${NAME} already exists in Arak. Use --rotate to give it a new password`);
  let id;
  if (found) {
    id = found.id;
    await call('POST', `/v1/principals/${id}/password`, { password: first }, t);
    console.log(`${NAME}: password reset by ${admin.user.username}`);
  } else {
    const r = await call('POST', '/v1/principals', { username: NAME, displayName: 'Bancha sync (service account)', principalType: 'SERVICE',
      password: first, roles: [{ appRole: 'PLATFORM_ADMIN', scopeFqn: null }] }, t);
    id = r.principal.id;
    console.log(`${NAME}: created as a local SERVICE with PLATFORM_ADMIN`);
  }

  // Arak marks a password an admin chose as must-change. Changing it once, as the account itself, clears that.
  const chosen = newPassword();
  const s = await login(NAME, first);
  await call('POST', '/v1/auth/password', { currentPassword: first, newPassword: chosen }, s.accessToken);
  const check = await login(NAME, chosen);
  if (check.mustChangePassword) throw new Error('Arak still asks for a password change');
  if (!(check.user.roles || []).includes('PLATFORM_ADMIN')) console.log('note: the login response does not list PLATFORM_ADMIN; check the account in Arak');

  writeEnv({ ARAK_URL: BASE, ARAK_USER: NAME, ARAK_PASSWORD: chosen });
  console.log(`${NAME}: signs in, no password change pending. ARAK_URL, ARAK_USER and ARAK_PASSWORD written to .env (mode 600)`);
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
