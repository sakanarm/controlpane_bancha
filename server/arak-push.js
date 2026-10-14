#!/usr/bin/env node
// Pushes users, groups, roles and connections decided in Bancha into Arak, through Arak's own admin API
// (/v1/principals, /v1/sources, /v1/settings/openmetadata). No change to Arak is needed: Bancha signs in as an
// Arak PLATFORM_ADMIN and calls the same endpoints Arak's Users, Sources and OpenMetadata screens use.
//
//   node server/arak-push.js <desired.json>           show what would change, change nothing
//   node server/arak-push.js <desired.json> --apply   make the changes, then read Arak back and compare
//   node server/arak-push.js <desired.json> --undo    take back what the file gives and disable the users it created
//
// Env: ARAK_URL (for example http://127.0.0.1:8090/api), and ARAK_TOKEN or ARAK_USER + ARAK_PASSWORD.
//
// What Arak allows, read from its code (14 Oct 2026):
// - New principals are source 'local'. Arak's CHECK allows only entra, openmetadata and local, so there is no 'bancha' source.
// - Only local principals can be enabled, disabled or join groups. Roles and local attribute rows can go on any principal.
// - Only DATA_OWNER takes a scope. A role change reaches a user at their next sign-in, since roles are baked into the token.
// - A user created without a password signs in with Microsoft, found by email.
// - Arak seals a source login with its own key and never returns it, so Bancha sends it when it adds a source and
//   otherwise leaves the stored one. Arak's OpenMetadata client takes a bot token, not a password login.
'use strict';
const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'contracts', 'examples', 'arak.bancha-app.yaml');
// Bancha fields Arak stores as principal_attribute rows. Other keys (clearance, tenant, ...) belong to Arak and are never touched.
const ATTRS = ['department', 'employeeType', 'country'];

// Role key -> Arak value, from the roles list in the manifest. Tiny reader: the manifest is ours and the list is flat.
function manifestRoles(file) {
  const roles = {}; let cur = null, inRoles = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^  roles:\s*$/.test(line)) { inRoles = true; continue; }
    if (inRoles && /^  \S/.test(line)) break;
    if (!inRoles) continue;
    let m;
    if ((m = line.match(/^    - key:\s*(\S+)/))) cur = roles[m[1]] = { key: m[1] };
    else if (cur && (m = line.match(/^      (appValue|scoped):\s*([^#\s]+)/))) cur[m[1]] = m[2] === 'true' ? true : m[2];
  }
  return roles;
}

const BASE = (process.env.ARAK_URL || 'http://127.0.0.1:8090/api').replace(/\/$/, '');
let token = process.env.ARAK_TOKEN || '';

async function call(method, url, body) {
  const res = await fetch(BASE + url, { method,
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data)}`);
  return data;
}
const q = o => '?' + new URLSearchParams(o).toString();

async function signIn() {
  if (token) return;
  const { ARAK_USER: username, ARAK_PASSWORD: password } = process.env;
  if (!username || !password) throw new Error('Set ARAK_TOKEN, or ARAK_USER and ARAK_PASSWORD');
  const r = await call('POST', '/v1/auth/login', { username, password });
  if (r.mustChangePassword) throw new Error(`${username} must change its password in Arak before it can be used`);
  token = r.accessToken;
}

// Finds the Arak principal for a Bancha user or group. Users match by email (manifest: match email), then by local username.
async function find(type, item) {
  const keyText = item.email || item.username || item.name;
  const rows = await call('GET', '/v1/principals' + q({ type, q: keyText, limit: 50 }));
  const lc = s => (s || '').toLowerCase();
  return (item.email && rows.find(p => lc(p.email) === lc(item.email)))
    || rows.find(p => p.source === 'local' && lc(p.username) === lc(item.username || item.name)) || null;
}

async function main() {
  const [file, mode = '--plan'] = process.argv.slice(2);
  if (!file || !['--plan', '--apply', '--undo'].includes(mode)) { console.error('usage: node server/arak-push.js <desired.json> [--apply|--undo]'); process.exit(2); }
  const want = JSON.parse(fs.readFileSync(file, 'utf8'));
  const roleMap = manifestRoles(MANIFEST);
  const reason = want.reason || 'Bancha central config';
  const apply = mode !== '--plan', undo = mode === '--undo';
  await signIn();

  const grants = (await call('GET', '/v1/principals/roles')).grants;
  const steps = [];
  const step = (text, fn) => steps.push({ text, fn });

  // Groups first, so users can join them.
  const groupIds = {};
  for (const g of want.groups || []) {
    const p = await find('GROUP', g);
    if (p) groupIds[g.name] = p.id;
    else if (!undo) step(`create local group ${g.name}`, async () => {
      const r = await call('POST', '/v1/principals', { username: g.name, displayName: g.displayName || g.name, principalType: 'GROUP' });
      groupIds[g.name] = r.principal.id;
    });
  }

  for (const u of want.users || []) {
    const desiredRoles = (u.roles || []).map(r => {
      const m = roleMap[r.role]; if (!m) throw new Error(`role ${r.role} is not in the Arak manifest`);
      if (m.scoped && !r.scope) throw new Error(`${r.role} needs a scope`);
      return { appRole: m.appValue, scopeFqn: m.scoped ? r.scope : null };
    });
    let p = await find('USER', u);
    const label = `${u.username} <${u.email}>`;
    if (!p && undo) { console.log(`${label}: not in Arak, nothing to undo`); continue; }
    if (!p) {
      step(`create local user ${label} (no password: signs in with Microsoft by email)`, async () => {
        p = (await call('POST', '/v1/principals', { username: u.username, displayName: u.displayName, email: u.email, principalType: 'USER' })).principal;
      });
    }
    const id = () => p.id;
    const local = p?.source === 'local';
    const detail = p ? await call('GET', '/v1/principals/' + p.id) : { attributes: [], groups: [] };
    const held = grants.filter(g => p && g.principalId === p.id);
    const same = (a, b) => a.appRole === b.appRole && (a.scopeFqn || null) === (b.scopeFqn || null);

    if (undo) {
      for (const r of desiredRoles.filter(r => held.some(h => same(h, r))))
        step(`${label}: revoke ${r.appRole}${r.scopeFqn ? ' @ ' + r.scopeFqn : ''}`, () => call('DELETE', `/v1/principals/${id()}/roles` + q({ role: r.appRole, ...(r.scopeFqn ? { scope: r.scopeFqn } : {}), reason })));
      for (const a of detail.attributes.filter(a => a.source === 'local' && ATTRS.includes(a.key) && u[a.key] === a.value))
        step(`${label}: remove attribute ${a.key}=${a.value}`, () => call('DELETE', `/v1/principals/${id()}/attributes` + q({ key: a.key, value: a.value, reason })));
      for (const g of detail.groups.filter(g => (u.groups || []).includes(g.username) && groupIds[g.username]))
        step(`${label}: leave group ${g.username}`, () => call('DELETE', `/v1/principals/${g.id}/members/${id()}` + q({ reason })));
      if (local && p.enabled) step(`${label}: disable`, () => call('POST', `/v1/principals/${id()}/enabled`, { enabled: false, reason }));
      continue;
    }

    if (p && !local) console.log(`${label}: found as ${p.source} ${p.username}; Bancha links to it and leaves its username, status and groups to ${p.source}`);
    for (const r of desiredRoles.filter(r => !held.some(h => same(h, r))))
      step(`${label}: grant ${r.appRole}${r.scopeFqn ? ' @ ' + r.scopeFqn : ''}`, () => call('POST', `/v1/principals/${id()}/roles`, { ...r, reason }));
    for (const key of ATTRS.filter(k => u[k])) {
      const mine = detail.attributes.filter(a => a.source === 'local' && a.key === key);
      if (mine.some(a => a.value === u[key])) continue;
      for (const old of mine) step(`${label}: remove attribute ${key}=${old.value}`, () => call('DELETE', `/v1/principals/${id()}/attributes` + q({ key, value: old.value, reason })));
      step(`${label}: set attribute ${key}=${u[key]}`, () => call('POST', `/v1/principals/${id()}/attributes`, { key, value: u[key], reason }));
    }
    if (local || !p) {
      for (const name of (u.groups || []).filter(n => !detail.groups.some(g => g.username === n))) {
        if (!(want.groups || []).some(g => g.name === name)) throw new Error(`group ${name} is not in the groups list`);
        step(`${label}: join group ${name}`, () => call('POST', `/v1/principals/${groupIds[name]}/members`, { memberId: id(), reason }));
      }
      const enabled = (u.status || 'active') === 'active';
      if (p && p.enabled !== enabled) step(`${label}: ${enabled ? 'enable' : 'disable'}`, () => call('POST', `/v1/principals/${id()}/enabled`, { enabled, reason }));
    }
  }

  const conns = loadConnections(want);
  await planConnections(conns, step, undo, reason);

  if (!steps.length) console.log('Arak already matches. Nothing to do.');
  for (const s of steps) {
    if (!apply) { console.log('would ' + s.text); continue; }
    await s.fn(); console.log('done  ' + s.text);
  }
  if (apply) { await verify(want, roleMap, undo); await verifyConnections(conns, undo); }
}

// Connections. Bancha decides where and how to connect: engine, host, port, database and login.
// Arak keeps the rest: enforcement mode, secure schema and pattern, table scope, OpenMetadata service, and whether the source is on.
// Only connections whose grants name arak are sent, with the profile the grant names.
const ENGINES = { postgresql: 'POSTGRES', mssql: 'SQLSERVER', 'sql server': 'SQLSERVER', mysql: 'MYSQL' };
const STORED = 'fernet:stored'; // what Arak serves instead of a sealed login; sending it back keeps the stored one

function loadConnections(want) {
  const file = want.connectionsFile ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', want.connectionsFile), 'utf8')).connections : [];
  return [...file, ...(want.connections || [])].filter(c => c.grants?.arak?.length);
}
const profileFor = c => c.profiles?.find(p => c.grants.arak.includes(p.p));
function secretOf(c, prof) {
  const v = prof && process.env[prof.secretEnv];
  if (!v) throw new Error(`connection ${c.id}: set ${prof?.secretEnv || 'a secret'} in Bancha's .env`);
  return v;
}
const findSource = (sources, c) => sources.find(s => s.name === c.id)
  || sources.find(s => s.host.toLowerCase() === c.host.toLowerCase() && s.port === c.port && (s.defaultDatabase || '') === (c.db || ''));

async function planConnections(conns, step, undo, reason) {
  if (!conns.length) return;
  const sources = await call('GET', '/v1/sources');
  for (const c of conns) {
    const label = `connection ${c.id}`;
    if (c.type === 'OpenMetadata') {
      if (undo) continue; // nothing is written for it unless the address changes, and an old address is not worth restoring
      const om = await call('GET', '/v1/settings/openmetadata');
      const prof = profileFor(c), token = prof?.tokenEnv ? process.env[prof.tokenEnv] : null;
      const same = om.baseUrl.replace(/\/$/, '') === c.url.replace(/\/$/, '');
      if (same && !token) console.log(`${label}: Arak already points at ${c.url} (${om.source}). Arak keeps its own token (${om.tokenSource}): it needs a bot token, and Bancha holds a password login`);
      else step(`${label}: point Arak's OpenMetadata at ${c.url}${token ? " with Bancha's bot token" : ''}`,
        () => call('PUT', '/v1/settings/openmetadata', { baseUrl: c.url, ...(token ? { jwtToken: token } : {}), reason }));
      continue;
    }
    if (c.cat !== 'data_source') continue;
    const engine = ENGINES[(c.type || '').toLowerCase()];
    if (!engine) { console.log(`${label}: Arak has no ${c.type} engine, skipped`); continue; }
    const s = findSource(sources, c);
    if (undo) {
      if (!s) continue;
      if (s.name !== c.id || s.enabled || s.assetCount) { console.log(`${label}: Arak source ${s.name} stays. Bancha removes only a source it added that is still off and empty`); continue; }
      step(`${label}: remove Arak source ${s.name}`, () => call('DELETE', '/v1/sources/' + s.id));
      continue;
    }
    const prof = profileFor(c);
    if (!s) {
      step(`${label}: add Arak source ${c.id} (${engine} ${c.host}:${c.port}/${c.db}, login ${prof?.user}), off and enforcement NONE until an Arak admin turns it on`,
        () => call('POST', '/v1/sources', { name: c.id, engine, host: c.host, port: c.port, defaultDatabase: c.db,
          username: prof.user, password: secretOf(c, prof), enabled: false, defaultEnforcementMode: 'NONE' }));
      continue;
    }
    const drift = [['host', s.host, c.host], ['port', s.port, c.port], ['database', s.defaultDatabase, c.db], ['engine', s.engine, engine]]
      .filter(([, a, b]) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase());
    if (!drift.length) { console.log(`${label}: linked to Arak source ${s.name}, host, port and database match`); continue; }
    step(`${label}: update Arak source ${s.name}: ${drift.map(([k, a, b]) => `${k} ${a} -> ${b}`).join(', ')}`,
      () => call('PUT', '/v1/sources/' + s.id, { name: s.name, engine, engineVersion: s.engineVersion, host: c.host, port: c.port, defaultDatabase: c.db,
        credentialRef: s.credentialRef?.startsWith('fernet:') ? STORED : s.credentialRef, defaultEnforcementMode: s.defaultEnforcementMode,
        omServiceFqn: s.omServiceFqn, secureSchema: s.secureSchema, secureObjectPattern: s.secureObjectPattern, tableScope: s.tableScope, enabled: s.enabled }));
  }
}

// Asks Arak to connect with what Bancha sent. Neither probe saves anything except the engine version Arak reads.
async function verifyConnections(conns, undo) {
  if (!conns.length) return;
  console.log('\nArak connections now:');
  const sources = await call('GET', '/v1/sources');
  for (const c of conns) {
    if (c.type === 'OpenMetadata') {
      if (undo) continue;
      const om = await call('GET', '/v1/settings/openmetadata');
      const probe = await call('POST', '/v1/settings/openmetadata/test', { baseUrl: c.url });
      console.log(`  ${c.id}: Arak uses ${om.baseUrl} (${om.source}), token from ${om.tokenSource}`);
      console.log(`    probe: ${JSON.stringify(probe).slice(0, 200)}`);
      if (om.baseUrl.replace(/\/$/, '') !== c.url.replace(/\/$/, '')) { console.log('    DOES NOT MATCH the file'); process.exitCode = 1; }
      else console.log('    MATCHES the file');
      continue;
    }
    if (c.cat !== 'data_source' || !ENGINES[(c.type || '').toLowerCase()]) continue;
    const s = findSource(sources, c);
    if (undo) { console.log(`  ${c.id}: ${s ? 'still in Arak as ' + s.name : 'not in Arak'}`); continue; }
    if (!s) { console.log(`  ${c.id}: missing`); process.exitCode = 1; continue; }
    const t = await call('POST', `/v1/sources/${s.id}/test`);
    console.log(`  ${c.id}: Arak source ${s.name} ${s.engine} ${s.host}:${s.port}/${s.defaultDatabase} enabled=${s.enabled} enforcement=${s.defaultEnforcementMode} login=${s.credentialRef === STORED ? 'sealed by Arak' : s.credentialRef}`);
    console.log(`    connect test: ${t.reachable ? 'reachable' : 'NOT reachable'} ${t.productName || ''} ${t.engineVersion || ''} ${t.message ? '- ' + t.message : ''}`);
    if (!t.reachable) process.exitCode = 1;
  }
}

// Reads Arak back and compares it with the file.
async function verify(want, roleMap, undo) {
  console.log('\nArak now holds:');
  const grants = (await call('GET', '/v1/principals/roles')).grants;
  for (const u of want.users || []) {
    const p = await find('USER', u); if (!p) { console.log(`  ${u.username}: missing`); continue; }
    const d = await call('GET', '/v1/principals/' + p.id);
    const roles = grants.filter(g => g.principalId === p.id).map(g => g.appRole + (g.scopeFqn ? ' @ ' + g.scopeFqn : ''));
    const attrs = d.attributes.filter(a => ATTRS.includes(a.key)).map(a => `${a.key}=${a.value} (${a.source})`);
    console.log(`  ${p.username} <${p.email}> source=${p.source} enabled=${p.enabled}`);
    console.log(`    roles:  ${roles.join(', ') || '-'}`);
    console.log(`    attrs:  ${attrs.join(', ') || '-'}`);
    console.log(`    groups: ${d.groups.map(g => g.username).join(', ') || '-'}`);
    const wantRoles = undo ? [] : (u.roles || []).map(r => roleMap[r.role].appValue + (r.scope ? ' @ ' + r.scope : ''));
    const ok = wantRoles.every(r => roles.includes(r)) && (!undo || roles.length === 0)
      && ATTRS.every(k => !u[k] || undo !== d.attributes.some(a => a.key === k && a.value === u[k] && a.source === 'local'))
      && (u.groups || []).every(n => undo !== d.groups.some(g => g.username === n));
    console.log(`    ${ok ? 'MATCHES the file' : 'DOES NOT MATCH the file'}`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
