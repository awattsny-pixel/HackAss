-- F2-B (1/4): hack identity, content versions and the hashed child records. Tables only; behaviour is in the next files.
--
-- What is HASHED (everything an author writes, see docs/db/hashcanon-1.md): the scalar columns of hack_versions, and every row of
-- hack_steps, hack_materials, hack_requirements, version_tags, version_attributions, source_claims and version_assets.
-- What is NOT content and never hashed: hacks (identity), version_lifecycle (mutable state), submissions (immutable record), the
-- seal columns (frozen_at, content_hash, canon_version) and bookkeeping timestamps. Privileged classification and approval
-- (risk class, rights reviews, decisions) will live in separate, staff-only tables (F2-C); none of it is a column here, so a
-- contributor cannot supply it.
--
-- Nothing in this file is granted to anyone: every table is owner-only (hackass_owner) with RLS on and no policies.

-- The owner role has no database-level CREATE, so postgres creates the schema on its behalf.
create schema app_content authorization hackass_owner;

set local role hackass_owner;

revoke all on schema app_content from public;
comment on schema app_content is 'F2-B: content validation, canonical hashing and immutability guards. Owner-only.';

-- Text hygiene shared by every CHECK: bounded length and no control characters other than newline (CR is normalized to LF before storage).
create function app_content.clean_text(p text, p_min integer, p_max integer) returns boolean
  language sql immutable security definer set search_path = ''
as $$
  select p is null or (pg_catalog.char_length(p) between p_min and p_max and p !~ E'[\\x01-\\x09\\x0b-\\x1f\\x7f\\u0080-\\u009f]')
$$;
revoke all on function app_content.clean_text(text, integer, integer) from public;

create table app.categories (
  id         uuid        primary key default pg_catalog.gen_random_uuid(),
  slug       text        not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(slug) <= 40),
  name       text        not null check (app_content.clean_text(name, 1, 80)),
  created_at timestamptz not null default pg_catalog.now()
);

-- Identity only. The publication pointer (current_publication_id) arrives with publications in F2-C.
create table app.hacks (
  id         uuid        primary key default pg_catalog.gen_random_uuid(),
  slug       text        unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(slug) <= 80),
  created_by uuid        not null references app.accounts (user_id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now()
);
comment on column app.hacks.slug is 'Null until publication assigns one (F2-C).';

create table app.hack_versions (
  id          uuid        primary key default pg_catalog.gen_random_uuid(),
  hack_id     uuid        not null references app.hacks (id) on delete restrict,
  version_no  integer     not null check (version_no >= 1),
  created_by  uuid        not null references app.accounts (user_id) on delete restrict,
  created_at  timestamptz not null default pg_catalog.now(),
  -- content (hashed)
  category_id       uuid references app.categories (id),
  title             text check (app_content.clean_text(title, 1, 120)),
  summary           text check (app_content.clean_text(summary, 1, 500)),
  outcome           text check (app_content.clean_text(outcome, 1, 1000)),
  difficulty        text check (difficulty in ('easy', 'moderate', 'hard')),
  time_min_minutes  integer check (time_min_minutes between 0 and 525600),
  time_max_minutes  integer check (time_max_minutes between 0 and 525600),
  cost_min_cents    bigint  check (cost_min_cents between 0 and 100000000),
  cost_max_cents    bigint  check (cost_max_cents between 0 and 100000000),
  currency          text    check (currency ~ '^[A-Z]{3}$'),
  estimate_basis    text    check (app_content.clean_text(estimate_basis, 1, 500)),
  ai_requirement    text    check (ai_requirement in ('none', 'helpful', 'required')),
  limitations       text    check (app_content.clean_text(limitations, 1, 2000)),
  -- seal (not content)
  frozen_at     timestamptz,
  content_hash  bytea check (pg_catalog.octet_length(content_hash) = 32),
  canon_version smallint check (canon_version = 1),
  constraint hack_versions_unique_no   unique (hack_id, version_no),
  constraint hack_versions_id_hack     unique (id, hack_id),
  constraint hack_versions_time_order  check (time_min_minutes is null or time_max_minutes is null or time_min_minutes <= time_max_minutes),
  constraint hack_versions_cost_order  check (cost_min_cents is null or cost_max_cents is null or cost_min_cents <= cost_max_cents),
  constraint hack_versions_seal_all_or_none check ((frozen_at is null) = (content_hash is null) and (frozen_at is null) = (canon_version is null))
);
-- at most one open (unfrozen) draft per hack
create unique index hack_versions_one_open_draft on app.hack_versions (hack_id) where frozen_at is null;
create index hack_versions_owner on app.hack_versions (created_by, created_at desc);

-- Lifecycle is separate and mutable; changing it never touches content.
create table app.version_lifecycle (
  version_id       uuid        primary key references app.hack_versions (id) on delete cascade,
  state            text        not null check (state in ('draft', 'submitted', 'under_review', 'approved', 'superseded', 'withdrawn', 'rejected')),
  state_changed_at timestamptz not null default pg_catalog.now()
);

-- Immutable record of a submission (one per version).
create table app.submissions (
  id            uuid        primary key default pg_catalog.gen_random_uuid(),
  hack_id       uuid        not null,
  version_id    uuid        not null unique,
  submitter_id  uuid        not null references app.accounts (user_id) on delete restrict,
  content_hash  bytea       not null check (pg_catalog.octet_length(content_hash) = 32),
  canon_version smallint    not null check (canon_version = 1),
  created_at    timestamptz not null default pg_catalog.now(),
  constraint submissions_version_belongs_to_hack foreign key (version_id, hack_id) references app.hack_versions (id, hack_id) on delete restrict
);

-- ---- hashed child records (each belongs to exactly one version) ----------------------------------------------------------------
create table app.hack_steps (
  version_id uuid    not null references app.hack_versions (id) on delete cascade,
  position   integer not null check (position between 1 and 50),
  body       text    not null check (app_content.clean_text(body, 1, 2000)),
  primary key (version_id, position)
);
create table app.hack_materials (
  version_id uuid    not null references app.hack_versions (id) on delete cascade,
  position   integer not null check (position between 1 and 50),
  name       text    not null check (app_content.clean_text(name, 1, 200)),
  detail     text    check (app_content.clean_text(detail, 1, 500)),
  primary key (version_id, position)
);
create table app.hack_requirements (
  version_id uuid not null references app.hack_versions (id) on delete cascade,
  kind       text not null check (kind in ('tool', 'skill', 'account', 'other')),
  name       text not null check (app_content.clean_text(name, 1, 200)),
  detail     text check (app_content.clean_text(detail, 1, 500)),
  primary key (version_id, kind, name)
);
create table app.version_tags (
  version_id uuid not null references app.hack_versions (id) on delete cascade,
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(slug) <= 40),
  primary key (version_id, slug)
);
create table app.version_attributions (
  version_id     uuid    not null references app.hack_versions (id) on delete cascade,
  attribution_no integer not null check (attribution_no between 1 and 10),
  role           text    not null check (role in ('author', 'source_author', 'contributor', 'variation_parent')),
  profile_id     uuid,
  external_name  text    check (app_content.clean_text(external_name, 1, 200)),
  external_url   text    check (external_url is null or (external_url ~ '^https?://[^[:space:]]+$' and pg_catalog.char_length(external_url) <= 500)),
  primary key (version_id, attribution_no),
  constraint attribution_member_xor_external check ((profile_id is null) <> (external_name is null))
);
comment on column app.version_attributions.profile_id is 'Declared by the author; verification is a separate staff record (F2-C). No foreign key until profiles exist.';
create table app.source_claims (
  version_id         uuid    not null references app.hack_versions (id) on delete cascade,
  claim_no           integer not null check (claim_no between 1 and 10),
  kind               text    not null check (kind in ('original_work', 'own_prior_work', 'third_party_reuse', 'licensed', 'permission_granted')),
  canonical_url      text    check (canonical_url is null or (canonical_url ~ '^https?://[^[:space:]]+$' and pg_catalog.char_length(canonical_url) <= 500)),
  source_author      text    check (app_content.clean_text(source_author, 1, 200)),
  license_spdx       text    check (app_content.clean_text(license_spdx, 1, 100)),
  license_version    text    check (app_content.clean_text(license_version, 1, 50)),
  permission_note    text    check (app_content.clean_text(permission_note, 1, 1000)),
  asset_rights_note  text    check (app_content.clean_text(asset_rights_note, 1, 1000)),
  primary key (version_id, claim_no)
);
create table app.version_assets (
  version_id uuid  not null references app.hack_versions (id) on delete cascade,
  sha256     bytea not null check (pg_catalog.octet_length(sha256) = 32),
  asset_id   uuid  not null,
  primary key (version_id, sha256)
);
comment on column app.version_assets.asset_id is 'No foreign key until the asset store exists.';

-- Owner-only, default deny (the default privileges from F2-A already keep PUBLIC out; RLS is the second wall).
alter table app.categories           enable row level security;
alter table app.hacks                enable row level security;
alter table app.hack_versions        enable row level security;
alter table app.version_lifecycle    enable row level security;
alter table app.submissions          enable row level security;
alter table app.hack_steps           enable row level security;
alter table app.hack_materials       enable row level security;
alter table app.hack_requirements    enable row level security;
alter table app.version_tags         enable row level security;
alter table app.version_attributions enable row level security;
alter table app.source_claims        enable row level security;
alter table app.version_assets       enable row level security;

reset role;
