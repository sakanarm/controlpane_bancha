// Admin API on Bancha's own database (ARCHITECTURE §10, ROADMAP 1.3 and 1.10): users, groups, members, role bindings,
// apps and the audit trail. Every write runs in one transaction with its audit_log row and its change_log event, and
// then tells arak-sync, which pushes what Arak should hold (server/arak-desired.js).
//
// Routes, under /api/v1/admin (the caller is a signed-in console admin; server.js checks that first):
//   GET  /users?q=&status=          POST /users            GET/PATCH/DELETE /users/{id}
//   GET  /groups?q=                 POST /groups           GET/PATCH/DELETE /groups/{id}
//   PUT  /groups/{id}/members {userIds}   POST /groups/{id}/members {userId}   DELETE /groups/{id}/members/{userId}
//   GET  /role-bindings?app=&subjectId=   POST /role-bindings   DELETE /role-bindings/{id}
//   GET  /apps                      GET /audit?limit=&target=
//
// DELETE /users/{id} marks the user deleted and keeps the row, so Arak and Prajak history keeps its reference (§3.2).
'use strict';
const crypto = require('crypto');
const db = require('./db');
const manifests = require('./manifests');

const LIMIT = 500;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,99}$/;
const GROUPNAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{1,99}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => { throw new HttpError(400, m); };
const notFound = what => { throw new HttpError(404, `${what} not found`); };

// Crockford base32 ULID, for change_log event ids (evt_<ulid>): sortable by time, unique without a sequence.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let t = Date.now(), time = '';
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  return time + [...crypto.randomBytes(16)].map(b => B32[b % 32]).join('');
}

// Text fields: trimmed, empty becomes null, too long is refused.
function text(v, name, { required = false, max = 200 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') { if (required) bad(`${name} is required`); return null; }
  const s = String(v).trim();
  if (s.length > max) bad(`${name} is longer than ${max} characters`);
  return s;
}

// One audit row and, for resource changes, one change_log event, inside the caller's transaction.
async function record(c, ctx, { action, type, id, before = null, after = null, event = null, version = 1 }) {
  await c.query(`insert into audit_log (actor_type, actor_id, action, target_type, target_id, before, after, ip)
    values ('user', $1, $2, $3, $4, $5, $6, $7)`, [ctx.actor.username, action, type, id, before, after, ctx.ip || null]);
  if (event) await c.query(`insert into change_log (event_id, type, subject_type, subject_id, subject_version, payload)
    values ($1, $2, $3, $4, $5, $6)`, ['evt_' + ulid(), event, type, id, version, after || before || {}]);
}

// The Bancha user row for the signed-in admin, if there is one (role_bindings.granted_by).
async function actorId(c, ctx) {
  if (!ctx.actor.email) return null;
  return (await c.query('select id from users where email = $1', [ctx.actor.email])).rows[0]?.id || null;
}

/* ── Users ── */

const USER_COLS = `u.id, u.username, u.email, u.display_name as "displayName", u.given_name as "givenName",
  u.family_name as "familyName", u.department, u.job_title as "jobTitle", u.employee_id as "employeeId", u.status,
  u.version, u.created_at as "createdAt", u.updated_at as "updatedAt", d.name as directory, d.type as "directoryType"`;
const USER_FIELDS = { displayName: 'display_name', email: 'email', givenName: 'given_name', familyName: 'family_name',
  department: 'department', jobTitle: 'job_title', employeeId: 'employee_id' };

async function getUser(c, id) {
  if (!UUID.test(id)) notFound('user');
  const u = (await c.query(`select ${USER_COLS} from users u join directories d on d.id = u.directory_id where u.id = $1`, [id])).rows[0];
  if (!u) notFound('user');
  return u;
}
// What audit and change_log keep about a user: the row without timestamps.
const userState = u => { const { createdAt, updatedAt, ...rest } = u; return rest; };

async function listUsers(q) {
  const term = text(q.get('q'), 'q'), status = text(q.get('status'), 'status');
  return (await db.query(`select ${USER_COLS},
      coalesce(array_agg(g.name order by g.name) filter (where g.id is not null), '{}') as groups,
      (select count(*)::int from role_bindings rb where rb.subject_type = 'user' and rb.subject_id = u.id) as "directRoles"
    from users u join directories d on d.id = u.directory_id
      left join group_members gm on gm.user_id = u.id left join groups g on g.id = gm.group_id
    where ($1::text is null or strpos(lower(u.username || ' ' || coalesce(u.email::text, '') || ' ' || u.display_name), lower($1)) > 0)
      and ($2::text is null or u.status = $2) and ($2::text is not null or u.status <> 'deleted')
    group by u.id, d.id order by u.display_name limit ${LIMIT}`, [term, status])).rows;
}

async function userDetail(c, id) {
  const u = await getUser(c, id);
  u.groups = (await c.query(`select g.id, g.name from group_members gm join groups g on g.id = gm.group_id
    where gm.user_id = $1 order by g.name`, [id])).rows;
  // Roles the user holds directly and through each group.
  u.roles = (await c.query(`select rb.id, rb.app_key as app, rb.role_key as role, rb.scope, null as via from role_bindings rb
      where rb.subject_type = 'user' and rb.subject_id = $1
    union all
    select rb.id, rb.app_key, rb.role_key, rb.scope, g.name from role_bindings rb join groups g on g.id = rb.subject_id
      join group_members gm on gm.group_id = g.id where rb.subject_type = 'group' and gm.user_id = $1
    order by 2, 3, 5 nulls first`, [id])).rows;
  return u;
}

async function createUser(b, ctx) {
  const username = text(b.username, 'username', { required: true, max: 100 });
  if (!USERNAME.test(username)) bad('username may use letters, digits and . _ @ - only');
  const email = text(b.email, 'email', { max: 254 });
  if (email && !EMAIL.test(email)) bad('email is not an email address');
  const vals = { display_name: text(b.displayName, 'displayName', { required: true }), email };
  for (const [k, col] of Object.entries(USER_FIELDS)) if (!(col in vals)) vals[col] = text(b[k], k);
  return db.tx(async c => {
    const dir = (await c.query(`select id from directories where name = 'local'`)).rows[0].id;
    const cols = Object.keys(vals);
    const id = (await c.query(`insert into users (directory_id, username, ${cols.join(', ')})
      values ($1, $2, ${cols.map((_, i) => '$' + (i + 3)).join(', ')}) returning id`, [dir, username, ...Object.values(vals)])).rows[0].id;
    const u = await getUser(c, id);
    await record(c, ctx, { action: 'user.create', type: 'users', id, after: userState(u), event: 'user.created' });
    return u;
  });
}

async function updateUser(id, b, ctx) {
  return db.tx(async c => {
    const before = await getUser(c, id);
    if (before.status === 'deleted') throw new HttpError(409, 'this user is deleted');
    const set = {};
    for (const [k, col] of Object.entries(USER_FIELDS)) if (k in b) set[col] = text(b[k], k, { required: k === 'displayName', max: k === 'email' ? 254 : 200 });
    if (set.email && !EMAIL.test(set.email)) bad('email is not an email address');
    if ('status' in b) {
      if (!['active', 'disabled'].includes(b.status)) bad('status is active or disabled (DELETE removes a user)');
      set.status = b.status;
      set.disabled_at = b.status === 'disabled' ? new Date() : null;
    }
    // People from a directory are owned by it (§3.1): only fields the directory does not send can change here.
    if (before.directoryType !== 'local') {
      const owned = ['display_name', 'email', 'given_name', 'family_name', 'status'].filter(k => k in set);
      if (owned.length) throw new HttpError(409, `${owned.join(', ')} come from ${before.directory}; change them there`);
    }
    if (!Object.keys(set).length) bad('nothing to change');
    const cols = Object.keys(set);
    await c.query(`update users set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now()
      where id = $1`, [id, ...Object.values(set)]);
    const after = await getUser(c, id);
    const event = 'status' in set && set.status !== before.status ? (set.status === 'disabled' ? 'user.disabled' : 'user.enabled') : 'user.updated';
    const action = { 'user.disabled': 'user.disable', 'user.enabled': 'user.enable', 'user.updated': 'user.update' }[event];
    await record(c, ctx, { action, type: 'users', id, before: userState(before), after: userState(after), event, version: after.version });
    return after;
  });
}

async function deleteUser(id, ctx) {
  return db.tx(async c => {
    const before = await getUser(c, id);
    if (before.status === 'deleted') return before;
    await c.query(`update users set status = 'deleted', disabled_at = coalesce(disabled_at, now()), version = version + 1,
      updated_at = now() where id = $1`, [id]);
    const after = await getUser(c, id);
    await record(c, ctx, { action: 'user.delete', type: 'users', id, before: userState(before), after: userState(after), event: 'user.deleted', version: after.version });
    return after;
  });
}

/* ── Groups ── */

async function getGroup(c, id) {
  if (!UUID.test(id)) notFound('group');
  const g = (await c.query(`select g.id, g.name, g.description, g.version, g.created_at as "createdAt", g.updated_at as "updatedAt",
      d.name as directory, d.type as "directoryType" from groups g join directories d on d.id = g.directory_id where g.id = $1`, [id])).rows[0];
  if (!g) notFound('group');
  return g;
}
const memberIds = async (c, id) => (await c.query('select user_id from group_members where group_id = $1 order by user_id', [id])).rows.map(r => r.user_id);

async function listGroups(q) {
  const term = text(q.get('q'), 'q');
  return (await db.query(`select g.id, g.name, g.description, g.version, d.name as directory,
      (select count(*)::int from group_members gm where gm.group_id = g.id) as members,
      coalesce((select json_agg(json_build_object('id', rb.id, 'app', rb.app_key, 'role', rb.role_key, 'scope', rb.scope)
        order by rb.app_key, rb.role_key) from role_bindings rb where rb.subject_type = 'group' and rb.subject_id = g.id), '[]') as roles
    from groups g join directories d on d.id = g.directory_id
    where $1::text is null or strpos(lower(g.name || ' ' || coalesce(g.description, '')), lower($1)) > 0
    order by g.name limit ${LIMIT}`, [term])).rows;
}

async function groupDetail(c, id) {
  const g = await getGroup(c, id);
  g.members = (await c.query(`select u.id, u.username, u.email, u.display_name as "displayName", u.status from group_members gm
    join users u on u.id = gm.user_id where gm.group_id = $1 order by u.display_name`, [id])).rows;
  g.roles = (await c.query(`select id, app_key as app, role_key as role, scope from role_bindings
    where subject_type = 'group' and subject_id = $1 order by 2, 3`, [id])).rows;
  return g;
}

async function createGroup(b, ctx) {
  const name = text(b.name, 'name', { required: true, max: 100 });
  if (!GROUPNAME.test(name)) bad('group name may use letters, digits, spaces and . _ - only');
  const description = text(b.description, 'description', { max: 500 });
  return db.tx(async c => {
    const dir = (await c.query(`select id from directories where name = 'local'`)).rows[0].id;
    const id = (await c.query('insert into groups (directory_id, name, description) values ($1, $2, $3) returning id', [dir, name, description])).rows[0].id;
    const g = await getGroup(c, id);
    await record(c, ctx, { action: 'group.create', type: 'groups', id, after: g, event: 'group.created' });
    return g;
  });
}

async function updateGroup(id, b, ctx) {
  // The name is how Arak finds the group (a local principal of that username), so it does not change here.
  if ('name' in b) bad('a group keeps its name; create a new group instead');
  if (!('description' in b)) bad('nothing to change');
  return db.tx(async c => {
    const before = await getGroup(c, id);
    await c.query('update groups set description = $2, version = version + 1, updated_at = now() where id = $1', [id, text(b.description, 'description', { max: 500 })]);
    const after = await getGroup(c, id);
    await record(c, ctx, { action: 'group.update', type: 'groups', id, before, after, event: 'group.updated', version: after.version });
    return after;
  });
}

async function deleteGroup(id, ctx) {
  return db.tx(async c => {
    const before = await groupDetail(c, id);
    await c.query(`delete from role_bindings where subject_type = 'group' and subject_id = $1`, [id]);
    await c.query('delete from groups where id = $1', [id]);   // members go with it (on delete cascade)
    await record(c, ctx, { action: 'group.delete', type: 'groups', id, before, event: 'group.deleted', version: Number(before.version) + 1 });
    return { ok: true };
  });
}

// Replaces the member list, or adds / removes one member. Bumps the group's version so the change is one event.
async function setMembers(id, { add = [], remove = [], replace = null }, ctx) {
  return db.tx(async c => {
    const g = await getGroup(c, id);
    const before = await memberIds(c, id);
    const ids = [...(replace || []), ...add, ...remove];
    if (ids.some(x => typeof x !== 'string' || !UUID.test(x))) bad('user ids must be uuids');
    if (ids.length) {
      const found = (await c.query(`select id, status from users where id = any($1::uuid[])`, [ids])).rows;
      const missing = ids.filter(x => !found.some(f => f.id === x));
      if (missing.length) bad(`unknown user ${missing[0]}`);
      if (found.some(f => f.status === 'deleted' && (replace || add).includes(f.id))) bad('a deleted user cannot join a group');
    }
    const want = replace ? [...new Set(replace)] : [...new Set([...before.filter(x => !remove.includes(x)), ...add])];
    const plus = want.filter(x => !before.includes(x)), minus = before.filter(x => !want.includes(x));
    if (!plus.length && !minus.length) return groupDetail(c, id);
    if (minus.length) await c.query('delete from group_members where group_id = $1 and user_id = any($2::uuid[])', [id, minus]);
    for (const u of plus) await c.query('insert into group_members (group_id, user_id) values ($1, $2)', [id, u]);
    await c.query('update groups set version = version + 1, updated_at = now() where id = $1', [id]);
    const after = await groupDetail(c, id);
    await record(c, ctx, { action: 'group.members', type: 'groups', id, before: { name: g.name, members: before },
      after: { name: g.name, members: await memberIds(c, id), added: plus, removed: minus }, event: 'group.members_changed', version: after.version });
    return after;
  });
}

/* ── Role bindings ── */

async function listBindings(q) {
  const app = text(q.get('app'), 'app'), subject = text(q.get('subjectId'), 'subjectId');
  if (subject && !UUID.test(subject)) bad('subjectId must be a uuid');
  return (await db.query(`select rb.id, rb.app_key as app, rb.role_key as role, rb.scope, rb.subject_type as "subjectType",
      rb.subject_id as "subjectId", coalesce(u.display_name, g.name) as "subjectName", coalesce(u.email::text, null) as "subjectEmail",
      u.status as "subjectStatus", ar.orphaned, rb.granted_at as "grantedAt"
    from role_bindings rb join app_roles ar on ar.app_key = rb.app_key and ar.role_key = rb.role_key
      left join users u on rb.subject_type = 'user' and u.id = rb.subject_id
      left join groups g on rb.subject_type = 'group' and g.id = rb.subject_id
    where ($1::text is null or rb.app_key = $1) and ($2::uuid is null or rb.subject_id = $2)
    order by rb.app_key, rb.role_key, 7 limit ${LIMIT * 4}`, [app, subject])).rows;
}

async function createBinding(b, ctx) {
  const app = text(b.app, 'app', { required: true }), role = text(b.role, 'role', { required: true });
  const subjectType = b.subjectType, subjectId = b.subjectId;
  if (!['user', 'group'].includes(subjectType)) bad('subjectType is user or group');
  if (typeof subjectId !== 'string' || !UUID.test(subjectId)) bad('subjectId must be a uuid');
  const scope = text(b.scope, 'scope', { max: 500 });
  let def;
  try { def = manifests.roleMap(app)[role]; } catch { bad(`unknown app ${app}`); }
  if (!def) bad(`${app} has no role ${role}`);
  if (def.scoped && !scope) bad(`${app} ${role} needs a scope`);
  if (!def.scoped && scope) bad(`${app} ${role} takes no scope`);
  return db.tx(async c => {
    const subject = subjectType === 'user'
      ? (await c.query('select id, display_name as name, status from users where id = $1', [subjectId])).rows[0]
      : (await c.query('select id, name from groups where id = $1', [subjectId])).rows[0];
    if (!subject) bad(`unknown ${subjectType}`);
    if (subject.status === 'deleted') bad('this user is deleted');
    const row = (await c.query(`insert into role_bindings (app_key, role_key, subject_type, subject_id, scope, granted_by)
      values ($1, $2, $3, $4, $5, $6) returning id, app_key as app, role_key as role, subject_type as "subjectType",
      subject_id as "subjectId", scope, granted_at as "grantedAt"`, [app, role, subjectType, subjectId, scope, await actorId(c, ctx)])).rows[0];
    const after = { ...row, subjectName: subject.name };
    await record(c, ctx, { action: 'rolebinding.grant', type: 'role_bindings', id: row.id, after, event: 'rolebinding.granted' });
    return after;
  });
}

async function deleteBinding(id, ctx) {
  if (!UUID.test(id)) notFound('role binding');
  return db.tx(async c => {
    const before = (await c.query(`delete from role_bindings where id = $1 returning id, app_key as app, role_key as role,
      subject_type as "subjectType", subject_id as "subjectId", scope, version`, [id])).rows[0];
    if (!before) notFound('role binding');
    await record(c, ctx, { action: 'rolebinding.revoke', type: 'role_bindings', id, before, event: 'rolebinding.revoked', version: Number(before.version) + 1 });
    return { ok: true };
  });
}

/* ── Apps and audit ── */

async function listApps() {
  return (await db.query(`select a.key, a.name, a.kind, a.status, a.delivery_mode as "deliveryMode", a.base_url as "baseUrl",
      coalesce((select json_agg(json_build_object('role', r.role_key, 'name', r.name, 'default', r.is_default, 'orphaned', r.orphaned,
        'bindings', (select count(*) from role_bindings rb where rb.app_key = r.app_key and rb.role_key = r.role_key)) order by r.role_key)
        from app_roles r where r.app_key = a.key), '[]') as roles
    from apps a order by a.key`)).rows
    .map(a => ({ ...a, roles: a.roles.map(r => ({ ...r, scoped: !!manifests.roleMap(a.key)[r.role]?.scoped })) }));
}

async function listAudit(q) {
  const limit = Math.min(Number(q.get('limit')) || 100, 500), target = text(q.get('target'), 'target');
  return (await db.query(`select id, at, actor_type as "actorType", actor_id as "actorId", action, target_type as "targetType",
      target_id as "targetId", before, after, host(ip) as ip from audit_log
    where $1::text is null or target_id = $1 order by id desc limit $2`, [target, limit])).rows;
}

/* ── Routing ── */

async function readBody(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 65536) bad('body too large'); }
  try { return s ? JSON.parse(s) : {}; } catch { bad('body is not JSON'); }
}

// Returns [status, body]. ctx = { actor: { username, email }, ip }. onChange(what) runs after a committed write.
async function handle(req, p, url, ctx, onChange = () => {}) {
  if (!db.ready) return [503, { error: 'Bancha database is not ready', db: db.status() }];
  const m = req.method, q = url.searchParams;
  const s = p.replace(/^\/api\/v1\/admin\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const write = async (fn, what, code = 200) => { const out = await fn(); onChange(what); return [code, out]; };
  try {
    const [res, id, sub, subId] = s;
    if (res === 'users') {
      if (!id && m === 'GET') return [200, await listUsers(q)];
      if (!id && m === 'POST') return await write(async () => createUser(await readBody(req), ctx), 'user created', 201);
      if (id && !sub && m === 'GET') return [200, await db.tx(c => userDetail(c, id))];
      if (id && !sub && m === 'PATCH') return await write(async () => updateUser(id, await readBody(req), ctx), 'user updated');
      if (id && !sub && m === 'DELETE') return await write(() => deleteUser(id, ctx), 'user deleted');
    }
    if (res === 'groups') {
      if (!id && m === 'GET') return [200, await listGroups(q)];
      if (!id && m === 'POST') return await write(async () => createGroup(await readBody(req), ctx), 'group created', 201);
      if (id && !sub && m === 'GET') return [200, await db.tx(c => groupDetail(c, id))];
      if (id && !sub && m === 'PATCH') return await write(async () => updateGroup(id, await readBody(req), ctx), 'group updated');
      if (id && !sub && m === 'DELETE') return await write(() => deleteGroup(id, ctx), 'group deleted');
      if (sub === 'members' && !subId && m === 'PUT') {
        const b = await readBody(req); if (!Array.isArray(b.userIds)) bad('send {"userIds": [...]}');
        return await write(() => setMembers(id, { replace: b.userIds }, ctx), 'group members');
      }
      if (sub === 'members' && !subId && m === 'POST') { const b = await readBody(req); return await write(() => setMembers(id, { add: [b.userId] }, ctx), 'group members'); }
      if (sub === 'members' && subId && m === 'DELETE') return await write(() => setMembers(id, { remove: [subId] }, ctx), 'group members');
    }
    if (res === 'role-bindings') {
      if (!id && m === 'GET') return [200, await listBindings(q)];
      if (!id && m === 'POST') return await write(async () => createBinding(await readBody(req), ctx), 'role granted', 201);
      if (id && m === 'DELETE') return await write(() => deleteBinding(id, ctx), 'role revoked');
    }
    if (res === 'apps' && !id && m === 'GET') return [200, await listApps()];
    if (res === 'audit' && !id && m === 'GET') return [200, await listAudit(q)];
    return [404, { error: 'not found' }];
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { error: e.message }];
    if (e.code === '23505') return [409, { error: conflict(e) }];
    if (e.code === '23503') return [400, { error: 'refers to something that does not exist' }];
    if (e.code === '22P02') return [400, { error: 'a value has the wrong type' }];
    throw e;
  }
}

function conflict(e) {
  if (/users_username/.test(e.constraint)) return 'a user with this username already exists';
  if (/users_email/.test(e.constraint)) return 'a user with this email already exists';
  if (/groups_name/.test(e.constraint)) return 'a group with this name already exists';
  if (/role_bindings/.test(e.constraint)) return 'this role is already given';
  return 'already exists';
}

module.exports = { handle };
