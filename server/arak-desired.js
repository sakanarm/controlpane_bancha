// What Arak should hold, read from Bancha's database, in the shape arak-push.js takes (users, groups).
//
// Only what Arak needs (PDPA, ARCHITECTURE §3.4):
// - groups that hold an Arak role;
// - users that hold an Arak role, directly or through one of those groups, with the fields the Arak manifest asks for.
// A group's roles are given to each member in Arak, rather than to the group principal, so a user's roles in Arak do
// not depend on how Arak resolves group roles at sign-in. Users who are disabled or deleted in Bancha go as disabled.
//
// Taking back: app_sync_state remembers each role and group membership Bancha has given in Arak (subject_type 'role'
// or 'member', status in_sync). One that is no longer wanted goes to arak-push.js as revoke / leave, so Bancha takes
// back what it gave and never what someone set in Arak directly. markPushed() records a push that went through.
'use strict';
const db = require('./db');

const roleKey = (userId, r) => `${userId}|${r.role}|${r.scope || ''}`;
const memberKey = (userId, group) => `${userId}|${group}`;

async function arakDesired() {
  const groups = (await db.query(`select distinct g.name from role_bindings rb join groups g on g.id = rb.subject_id
    where rb.app_key = 'arak' and rb.subject_type = 'group' order by g.name`)).rows.map(g => g.name);
  const held = (await db.query(`
    select rb.subject_id as user_id, rb.role_key as role, rb.scope from role_bindings rb
      where rb.app_key = 'arak' and rb.subject_type = 'user'
    union
    select gm.user_id, rb.role_key, rb.scope from role_bindings rb join group_members gm on gm.group_id = rb.subject_id
      where rb.app_key = 'arak' and rb.subject_type = 'group'`)).rows;
  const memberships = (await db.query(`select gm.user_id, g.name from group_members gm join groups g on g.id = gm.group_id
    where g.name = any($1)`, [groups])).rows;
  const pushed = (await db.query(`select subject_type, subject_id from app_sync_state
    where app_key = 'arak' and subject_type in ('role', 'member') and status = 'in_sync'`)).rows;

  // Per user: roles and groups wanted now, and what was given before but is no longer wanted.
  const per = new Map();
  const of = id => per.get(id) || per.set(id, { roles: [], groups: [], revoke: [], leave: [] }).get(id);
  const wantRole = new Set(), wantMember = new Set();
  for (const h of held) { of(h.user_id).roles.push({ role: h.role, scope: h.scope }); wantRole.add(roleKey(h.user_id, h)); }
  for (const m of memberships) if (per.has(m.user_id)) { of(m.user_id).groups.push(m.name); wantMember.add(memberKey(m.user_id, m.name)); }
  for (const p of pushed) {
    const [userId, a, ...rest] = p.subject_id.split('|'), b = rest.join('|');
    if (p.subject_type === 'role' && !wantRole.has(p.subject_id)) of(userId).revoke.push({ role: a, scope: b || null });
    if (p.subject_type === 'member' && !wantMember.has(p.subject_id)) of(userId).leave.push(a);
  }

  const people = (await db.query(`select id, username, email, display_name, department, status from users where id = any($1::uuid[])
    order by username`, [[...per.keys()]])).rows;
  const scoped = r => (r.scope ? { role: r.role, scope: r.scope } : { role: r.role });
  const users = people.map(u => {
    const x = per.get(u.id);
    return {
      username: u.username, email: u.email || undefined, displayName: u.display_name,
      status: u.status === 'active' ? 'active' : 'disabled',
      ...(u.department ? { department: u.department } : {}),
      groups: x.groups.sort(),
      roles: x.roles.map(scoped),
      ...(x.revoke.length ? { revoke: x.revoke.map(scoped) } : {}),
      ...(x.leave.length ? { leave: x.leave } : {}),
    };
  });
  // Groups a user must leave but that hold no Arak role any more: listed so Arak can find them, never created.
  const leaving = users.flatMap(u => u.leave || []).filter(n => !groups.includes(n));
  return {
    groups: [...groups.map(name => ({ name, displayName: name })), ...[...new Set(leaving)].map(name => ({ name, leaveOnly: true }))],
    users,
    snapshot: { roles: [...wantRole], members: [...wantMember], pushed: pushed.map(p => `${p.subject_type}:${p.subject_id}`) },
  };
}

// After a push that went through: what was wanted is now in Arak, what was taken back is not.
async function markPushed(snapshot) {
  await db.tx(async c => {
    for (const [type, keys] of [['role', snapshot.roles], ['member', snapshot.members]])
      if (keys.length) await c.query(`insert into app_sync_state (app_key, subject_type, subject_id, desired_version, applied_version, status)
        select 'arak', $1, k, 1, 1, 'in_sync' from unnest($2::text[]) k
        on conflict (app_key, subject_type, subject_id) do update set status = 'in_sync', applied_version = 1, last_error = null, updated_at = now()`,
        [type, keys]);
    const want = new Set([...snapshot.roles.map(k => 'role:' + k), ...snapshot.members.map(k => 'member:' + k)]);
    const gone = snapshot.pushed.filter(k => !want.has(k));
    if (gone.length) await c.query(`update app_sync_state set status = 'removed', updated_at = now()
      where app_key = 'arak' and subject_type || ':' || subject_id = any($1::text[])`, [gone]);
  });
}

module.exports = { arakDesired, markPushed };
