-- Bancha control plane schema (PostgreSQL 15+)
-- Every mutable resource carries `version`, bumped on each change and copied into change_log.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ───────────────────────────── Identity ─────────────────────────────

create table directories (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  type            text not null check (type in ('azure_ad', 'ldap', 'local')),
  connection_id   uuid,                                   -- FK added below; null for local
  sync_filter     text,                                   -- e.g. startsWith(displayName,'DG-')
  sync_interval   interval not null default '15 minutes',
  delta_token     text,                                   -- Graph deltaLink / LDAP highest USN
  last_sync_at    timestamptz,
  last_sync_status text check (last_sync_status in ('ok', 'partial', 'failed')),
  last_sync_error text,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

create table users (
  id                  uuid primary key default gen_random_uuid(),
  directory_id        uuid not null references directories(id),
  external_id         text,                               -- Azure objectId / LDAP DN
  username            text not null unique,
  email               citext unique,
  display_name        text not null,
  given_name          text,
  family_name         text,
  department          text,
  job_title           text,
  manager_id          uuid references users(id),
  employee_id         text,
  status              text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  disabled_at         timestamptz,
  version             bigint not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (directory_id, external_id)
);

create table groups (
  id              uuid primary key default gen_random_uuid(),
  directory_id    uuid not null references directories(id),
  external_id     text,
  name            text not null unique,
  description     text,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (directory_id, external_id)
);

create table group_members (
  group_id        uuid not null references groups(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  added_at        timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- ───────────────────────────── App registry ─────────────────────────────

create table apps (
  key             text primary key,                       -- arak, prajak, openmetadata, likit
  name            text not null,
  kind            text not null check (kind in ('App', 'Adapter')),
  base_url        text not null,
  status          text not null check (status in
                    ('pending', 'rejected', 'provisioning', 'failed', 'active',
                     'degraded', 'suspended', 'deregistering', 'removed')),
  delivery_mode   text not null check (delivery_mode in ('webhook', 'poll', 'adapter')),
  current_manifest_id uuid,
  approved_scopes jsonb not null default '{}',            -- groups filter, attributes, connection profiles, consumes
  applied_seq     bigint not null default 0,              -- reported by heartbeat
  last_heartbeat_at timestamptz,
  app_version     text,
  grace_until     timestamptz,                            -- set while deregistering
  registered_by   uuid references users(id),
  registered_at   timestamptz,
  removed_at      timestamptz,
  created_at      timestamptz not null default now()
);

create table app_manifests (
  id              uuid primary key default gen_random_uuid(),
  app_key         text not null references apps(key),
  manifest        jsonb not null,
  scope_diff      jsonb,                                  -- requested scopes vs approved
  status          text not null check (status in ('pending', 'approved', 'rejected', 'superseded')),
  submitted_at    timestamptz not null default now(),
  reviewed_by     uuid references users(id),
  reviewed_at     timestamptz
);
alter table apps add foreign key (current_manifest_id) references app_manifests(id);

create table app_roles (
  app_key         text not null references apps(key),
  role_key        text not null,
  name            text not null,
  description     text,
  is_default      boolean not null default false,
  orphaned        boolean not null default false,         -- removed from manifest but still bound
  primary key (app_key, role_key)
);

create table app_credentials (
  id              uuid primary key default gen_random_uuid(),
  app_key         text not null references apps(key),
  kind            text not null check (kind in ('client_secret', 'webhook_secret')),
  client_id       text,
  secret_hash     text,                                   -- client secret: hash only
  secret_ref      text,                                   -- webhook secret: vault ref (Bancha must sign with it)
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,                            -- overlap window during rotation
  revoked_at      timestamptz
);

create table registration_tokens (
  id              uuid primary key default gen_random_uuid(),
  app_key         text not null,
  token_hash      text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_by      uuid not null references users(id),
  created_at      timestamptz not null default now()
);

create table role_bindings (
  id              uuid primary key default gen_random_uuid(),
  app_key         text not null,
  role_key        text not null,
  subject_type    text not null check (subject_type in ('user', 'group')),
  subject_id      uuid not null,
  granted_by      uuid references users(id),
  granted_at      timestamptz not null default now(),
  version         bigint not null default 1,
  foreign key (app_key, role_key) references app_roles(app_key, role_key),
  unique (app_key, role_key, subject_type, subject_id)
);

-- ───────────────────────────── Connections ─────────────────────────────

create table connections (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,                   -- dwh-prod
  category        text not null check (category in ('data_source', 'metadata', 'directory')),
  type            text not null,                          -- postgresql, oracle, openmetadata, azure_ad ...
  config          jsonb not null,                         -- host, port, database, options. Never secrets.
  owner_group_id  uuid references groups(id),
  tags            text[] not null default '{}',
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_ms    integer,
  last_test_error text,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table directories add foreign key (connection_id) references connections(id);

create table credential_profiles (
  connection_id   uuid not null references connections(id) on delete cascade,
  profile         text not null check (profile in ('metadata', 'read', 'write', 'admin', 'default')),
  secret_ref      text not null,                          -- vault path or encrypted blob id
  username        text,
  rotated_at      timestamptz not null default now(),
  rotation_policy interval default '90 days',
  primary key (connection_id, profile)
);

create table connection_grants (
  app_key         text not null references apps(key),
  connection_id   uuid not null references connections(id) on delete cascade,
  profile         text not null,
  granted_by      uuid references users(id),
  granted_at      timestamptz not null default now(),
  version         bigint not null default 1,
  primary key (app_key, connection_id, profile),
  foreign key (connection_id, profile) references credential_profiles(connection_id, profile)
);

-- ───────────────────────────── Distribution ─────────────────────────────

-- Outbox and change feed. Written in the same transaction as the resource change.
create table change_log (
  seq             bigserial primary key,
  event_id        text not null unique,                   -- evt_<ulid>
  type            text not null,                          -- user.updated
  subject_type    text not null,                          -- users, groups, connections ...
  subject_id      text not null,
  subject_version bigint not null,
  payload         jsonb not null,                         -- full state; filtered per app at delivery time
  audience        text[],                                 -- null = everyone in scope; otherwise app keys
  created_at      timestamptz not null default now()
);
create index change_log_subject on change_log (subject_type, subject_id, seq desc);

create table deliveries (
  id              text primary key,                       -- dlv_<ulid>
  seq             bigint not null references change_log(seq),
  app_key         text not null references apps(key),
  status          text not null check (status in ('pending', 'delivered', 'retrying', 'dead', 'skipped')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz,
  last_status_code integer,
  last_error      text,
  latency_ms      integer,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (seq, app_key)
);
create index deliveries_due on deliveries (next_attempt_at) where status in ('pending', 'retrying');

-- What each app has applied, per resource. Drives the sync matrix and the PDPA "where is my data" report.
create table app_sync_state (
  app_key         text not null references apps(key),
  subject_type    text not null,
  subject_id      text not null,
  desired_version bigint not null,
  applied_version bigint,
  status          text not null check (status in ('in_sync', 'pending', 'error', 'removed')),
  last_error      text,
  updated_at      timestamptz not null default now(),
  primary key (app_key, subject_type, subject_id)
);

-- ───────────────────────────── Audit ─────────────────────────────

create table audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  actor_type      text not null check (actor_type in ('user', 'app', 'system')),
  actor_id        text not null,
  action          text not null,                          -- app.unregister, connection.rotate, rolebinding.grant
  target_type     text,
  target_id       text,
  before          jsonb,                                  -- secrets masked
  after           jsonb,
  request_id      text,
  ip              inet
);
-- Append-only: revoke update/delete from the application role.
-- revoke update, delete on audit_log from bancha_app;
