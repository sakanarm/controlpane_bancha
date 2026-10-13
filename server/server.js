// Bancha control plane: serves the console and tests the real connections in config/connections.json.
// Every check is read-only: Postgres sessions run with default_transaction_read_only=on, HTTP calls are GETs
// (plus the login call OpenMetadata and Azure AD need to issue a token). Secrets come from the environment only.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3950);
const HOST = process.env.BIND_HOST || '127.0.0.1';
const TIMEOUT_MS = 8000;
const RETEST_MS = 5 * 60 * 1000;

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'connections.json'), 'utf8')).connections;
const results = new Map();   // id -> { test, info }

const now = () => new Date().toTimeString().slice(0, 5);
const env = name => (name && process.env[name]) || '';

function missingOf(c) {
  const out = [];
  if (c.tenantEnv && !env(c.tenantEnv)) out.push({ what: 'Tenant ID', env: c.tenantEnv });
  for (const p of c.profiles) {
    if (p.userEnv && !env(p.userEnv)) out.push({ what: `${p.p} profile client ID`, env: p.userEnv });
    if (p.secretEnv && !env(p.secretEnv)) out.push({ what: `${p.p} profile ${c.type === 'Azure AD' ? 'client secret' : c.type === 'auth-service' ? 'API key' : 'password'}`, env: p.secretEnv });
  }
  return out;
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
  return body;
}

/* ── Connectors ── */

async function testPostgres(c) {
  const p = c.profiles[0];
  const cl = new Client({ host: c.host, port: c.port, database: c.db, user: p.user, password: env(p.secretEnv),
    connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS,
    options: '-c default_transaction_read_only=on', application_name: 'bancha-readonly-check' });
  await cl.connect();
  try {
    const v = (await cl.query(`select current_user as "user", current_database() as db, split_part(version(), ' on ', 1) as version,
      pg_is_in_recovery() as replica, (select rolsuper from pg_roles where rolname = current_user) as superuser,
      pg_size_pretty(pg_database_size(current_database())) as size`)).rows[0];
    const schemas = (await cl.query(`select table_schema as schema, count(*)::int as tables from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_toast%'
      group by 1 order by 2 desc, 1 limit 20`)).rows;
    return { version: v.version, user: v.user, superuser: v.superuser, replica: v.replica, size: v.size,
      tables: schemas.reduce((s, x) => s + x.tables, 0), schemas };
  } finally { await cl.end().catch(() => {}); }
}

const omTokens = new Map();   // id -> { token, exp }
async function omToken(c) {
  const t = omTokens.get(c.id);
  if (t && t.exp > Date.now() + 60000) return t.token;
  const p = c.profiles[0];
  const r = await getJSON(`${c.url}/api/v1/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: p.user, password: Buffer.from(env(p.secretEnv)).toString('base64') }) });
  if (!r.accessToken) throw new Error('OpenMetadata login returned no token');
  omTokens.set(c.id, { token: r.accessToken, exp: Date.now() + (r.expiryDuration ? Math.min(r.expiryDuration, 3600e3) : 3000e3) });
  return r.accessToken;
}
async function testOpenMetadata(c) {
  const version = await getJSON(`${c.url}/api/v1/system/version`);
  const token = await omToken(c);
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const total = async res => (await getJSON(`${c.url}/api/v1/${res}${res.includes('?') ? '&' : '?'}limit=1`, H)).paging?.total ?? null;
  const [users, teams, tables, services] = await Promise.all([total('users?isBot=false'), total('teams'), total('tables'),
    getJSON(`${c.url}/api/v1/services/databaseServices?limit=50`, H)]);
  return { version: version.version, users, teams, tables,
    databaseServices: services.data.map(s => { const cfg = s.connection?.config || {};
      return { name: s.name, type: s.serviceType, hostPort: cfg.hostPort, database: cfg.database, username: cfg.username }; }) };
}

async function testAzure(c) {
  const p = c.profiles[0], tenant = env(c.tenantEnv);
  const tok = await getJSON(`${c.url}/${tenant}/oauth2/v2.0/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env(p.userEnv), client_secret: env(p.secretEnv), grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default' }) });
  const H = { headers: { Authorization: `Bearer ${tok.access_token}`, ConsistencyLevel: 'eventual' } };
  const org = await getJSON('https://graph.microsoft.com/v1.0/organization?$select=displayName,verifiedDomains', H);
  const count = async res => Number(await (await fetch(`https://graph.microsoft.com/v1.0/${res}/$count`, { ...H, signal: AbortSignal.timeout(TIMEOUT_MS) })).text()) || null;
  return { tenant: org.value?.[0]?.displayName, users: await count('users').catch(() => null), groups: await count('groups').catch(() => null) };
}

async function testAuthService(c) {
  const health = await getJSON(`${c.url}/auth/health`);
  const key = env(c.profiles[0].secretEnv);
  if (!key) return { health };
  const u = await getJSON(`${c.url}/auth/users`, { headers: { 'x-api-key': key } });
  return { health, users: (u.users || []).length };
}

const CONNECTORS = { PostgreSQL: testPostgres, OpenMetadata: testOpenMetadata, 'Azure AD': testAzure, 'auth-service': testAuthService };

async function runTest(c) {
  const missing = missingOf(c);
  const started = Date.now();
  let test, info = results.get(c.id)?.info || null;
  // auth-service health needs no key, so it can still be checked while the key is missing.
  if (missing.length && c.type !== 'auth-service') {
    test = { ok: false, ms: null, at: now(), err: 'Not configured: ' + missing.map(m => m.what).join(', ') };
  } else {
    try {
      info = await CONNECTORS[c.type](c);
      test = { ok: true, ms: Date.now() - started, at: now() };
    } catch (e) {
      const msg = (e.cause && (e.cause.code || e.cause.message)) || e.code || e.message || String(e);
      test = { ok: false, ms: null, at: now(), err: String(msg).replace(/password=\S+/gi, 'password=***') };
    }
  }
  results.set(c.id, { test, info });
  console.log(`[test] ${c.id}: ${test.ok ? 'ok ' + test.ms + ' ms' : test.err}`);
  return results.get(c.id);
}

function view(c) {
  const r = results.get(c.id) || {};
  const host = c.host || (c.url ? new URL(c.url).hostname : '');
  const port = c.port || (c.url ? Number(new URL(c.url).port) || (c.url.startsWith('https') ? 443 : 80) : null);
  // URL-based connections show the full URL as the host, so no separate port.
  return { id: c.id, cat: c.cat, type: c.type, host: c.url ? c.url : host, port: c.url ? null : port,
    db: c.db || (c.tenantEnv ? (env(c.tenantEnv) || 'tenant not set') : '—'), owner: c.owner, note: c.note,
    profiles: c.profiles.map(p => ({ p: p.p, u: p.user || (p.userEnv && env(p.userEnv)) || '(not set)' })),
    grants: c.grants || {}, missing: missingOf(c), test: r.test || null, info: r.info || null };
}

/* ── HTTP ── */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    // Mounted under a prefix behind nginx (e.g. /Bancha) or at the root; only the tail matters.
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/bancha(?=\/|$)/i, '') || '/';
    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/connections' && req.method === 'GET') return send(res, 200, { live: true, connections: CONFIG.map(view) });
    const m = p.match(/^\/api\/connections\/([\w-]+)\/test$/);
    if (m && req.method === 'POST') {
      const c = CONFIG.find(x => x.id === m[1]);
      if (!c) return send(res, 404, { error: 'unknown connection' });
      await runTest(c);
      return send(res, 200, view(c));
    }
    if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(ROOT, 'prototype', 'control-plane.html')), TYPES['.html']);
    if (url.pathname === '/bancha' || url.pathname === '/Bancha') { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bancha listening on http://${HOST}:${PORT}`);
  const all = () => Promise.all(CONFIG.map(runTest));
  all(); setInterval(all, RETEST_MS).unref();
});
