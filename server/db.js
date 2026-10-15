// Bancha's own database (ROADMAP 1.1–1.2): a pool, transactions, and the migration runner.
//
//   node server/db.js            apply pending migrations, then exit
//   node server/db.js --status   list migrations and whether each has run
//
// The server also migrates on start and retries every minute until the database answers, so prod can be deployed
// before the database exists. Without BANCHA_DB_NAME the database is off and the admin API answers 503.
//
// Env: BANCHA_DB_HOST (127.0.0.1), BANCHA_DB_PORT (5432), BANCHA_DB_NAME, BANCHA_DB_USER (bancha), BANCHA_DB_PASSWORD
//
// Migrations are db/migrations/NNN_name.sql, applied in order, each in its own transaction, under an advisory lock so
// two processes never migrate at once. schema_migrations keeps a checksum; a file that changed after it ran is reported
// and blocks the start, because it means the database no longer matches the files.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const manifests = require('./manifests');

const DIR = path.join(__dirname, '..', 'db', 'migrations');
const LOCK = 7146921;            // pg_advisory_lock key for migrations; any constant shared by Bancha processes
const RETRY_MS = 60 * 1000;

const cfg = {
  host: process.env.BANCHA_DB_HOST || '127.0.0.1', port: Number(process.env.BANCHA_DB_PORT || 5432),
  database: process.env.BANCHA_DB_NAME, user: process.env.BANCHA_DB_USER || 'bancha', password: process.env.BANCHA_DB_PASSWORD,
};
const state = { enabled: !!cfg.database, ready: false, error: cfg.database ? 'starting' : 'BANCHA_DB_NAME is not set', applied: [] };

const pool = state.enabled ? new Pool({ ...cfg, max: 5, application_name: 'bancha', connectionTimeoutMillis: 8000,
  statement_timeout: 15000, idleTimeoutMillis: 30000 }) : null;
pool?.on('error', e => console.error('[db] idle client error:', e.message));

// bigint (versions, seq) as a JS number: these stay far below 2^53, and a string would turn version + 1 into '11'.
types.setTypeParser(20, v => Number(v));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const files = () => fs.readdirSync(DIR).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()
  .map(f => { const sql = fs.readFileSync(path.join(DIR, f), 'utf8'); return { version: f.replace(/\.sql$/, ''), sql, sum: crypto.createHash('sha256').update(sql).digest('hex') }; });

async function migrate({ log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK]);
    await c.query(`create table if not exists schema_migrations (version text primary key, checksum text not null,
      applied_at timestamptz not null default now())`);
    const done = new Map((await c.query('select version, checksum from schema_migrations')).rows.map(r => [r.version, r.checksum]));
    const ran = [];
    for (const m of files()) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.sum) throw new Error(`migration ${m.version} changed after it ran. Add a new migration instead of editing it`);
        continue;
      }
      await c.query('begin');
      try {
        await c.query(m.sql);
        await c.query('insert into schema_migrations (version, checksum) values ($1, $2)', [m.version, m.sum]);
        await c.query('commit');
      } catch (e) { await c.query('rollback').catch(() => {}); throw new Error(`migration ${m.version}: ${e.message}`); }
      log(`[db] applied ${m.version}`);
      ran.push(m.version);
    }
    return ran;
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
  }
}

// Apps and their roles come from the manifests in contracts/examples (until registration, 1.7, takes over).
// New apps start pending, except those Bancha already delivers to; an existing app keeps the status an admin gave it.
// A role gone from its manifest is kept and marked orphaned, so bindings to it stay visible until someone removes them.
const DELIVERING = new Set(['arak']);
async function syncApps() {
  await tx(async c => {
    for (const m of manifests.all()) {
      await c.query(`insert into apps (key, name, kind, base_url, status, delivery_mode, registered_at)
        values ($1, $2, $3, $4, $5, $6, now())
        on conflict (key) do update set name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, delivery_mode = excluded.delivery_mode`,
        [m.key, m.name, m.kind, m.baseUrl || '', DELIVERING.has(m.key) ? 'active' : 'pending', m.deliveryMode || 'webhook']);
      for (const r of m.roles)
        await c.query(`insert into app_roles (app_key, role_key, name, description, is_default) values ($1, $2, $3, $4, $5)
          on conflict (app_key, role_key) do update set name = excluded.name, description = excluded.description,
            is_default = excluded.is_default, orphaned = false`, [m.key, r.key, r.name || r.key, r.description || null, !!r.default]);
      await c.query('update app_roles set orphaned = true where app_key = $1 and not (role_key = any($2))', [m.key, m.roles.map(r => r.key)]);
    }
  });
}

// Server start: migrate and register apps; on failure keep trying, so the console runs while the database is not there yet.
let onReady = () => {};
async function start(cb) {
  if (cb) onReady = cb;
  if (!state.enabled) return console.log('[db] off: ' + state.error);
  try {
    state.applied = await migrate();
    await syncApps();
    Object.assign(state, { ready: true, error: null });
    console.log(`[db] ready: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    onReady();
  } catch (e) {
    state.error = e.code === 'ECONNREFUSED' ? `cannot reach ${cfg.host}:${cfg.port}` : e.message;
    console.error(`[db] not ready (${state.error}); retrying in ${RETRY_MS / 1000} s`);
    setTimeout(start, RETRY_MS).unref();
  }
}

const status = () => ({ enabled: state.enabled, ready: state.ready, error: state.error,
  database: state.enabled ? `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}` : null });

module.exports = { query, tx, migrate, start, status, get ready() { return state.ready; } };

if (require.main === module) {
  (async () => {
    if (!state.enabled) throw new Error('set BANCHA_DB_NAME (and BANCHA_DB_PASSWORD)');
    if (process.argv.includes('--status')) {
      const have = await query('select to_regclass($1) as t', ['schema_migrations']);
      const done = have.rows[0].t ? new Map((await query('select version, applied_at from schema_migrations')).rows.map(r => [r.version, r.applied_at])) : new Map();
      for (const m of files()) console.log(`${done.has(m.version) ? 'ran    ' + done.get(m.version).toISOString() : 'pending'}  ${m.version}`);
    } else {
      const ran = await migrate();
      await syncApps();
      console.log(ran.length ? `applied ${ran.length} migration(s); apps synced from manifests` : 'up to date; apps synced from manifests');
    }
    await pool.end();
  })().catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
