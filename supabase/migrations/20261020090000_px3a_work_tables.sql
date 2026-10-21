-- PX-3a (1/4): schema, types and tables
-- Private saving of a member's prompts and reflections. Same conventions as F2: owner hackass_owner, SECURITY DEFINER, empty search_path, guard first, EXECUTE to authenticated only.
-- Draft history: docs/px3/proposed/ (rehearsed before this migration existed).

-- schemas are created by postgres (hackass_owner has no CREATE on the database), exactly as in F2-A; everything else runs as the owner
create schema app_work authorization hackass_owner;

set local role hackass_owner;
revoke all on schema app_work from public;
comment on schema app_work is 'PX-3a: validation, hashing and write helpers for member work. Owner-only.';

create type app_work.prompt_doc as (title text, goal text, context text, output_format text, full_prompt text, starting_prompt text, origin_kind text, origin_slug text, origin_title text);
create type app_work.result_doc as (outcome text, reflection text, next_change text);

-- ---- tables ---------------------------------------------------------------------------------------------------------------------
create table app.saved_prompts (
  id              uuid        primary key default pg_catalog.gen_random_uuid(),
  owner_id        uuid        not null references app.accounts (user_id) on delete cascade,
  request_id      uuid        not null,                                   -- idempotency key for creates
  request_hash    text        not null check (request_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the CREATING payload: a retry must match it
  request_receipt jsonb       not null,                                   -- what the ORIGINAL create answered: an identical retry returns this, never a newer version
  title           text        not null check (pg_catalog.char_length(title) between 1 and 120),
  goal            text        not null default '' check (pg_catalog.char_length(goal) <= 2000),
  context         text        not null default '' check (pg_catalog.char_length(context) <= 4000),
  output_format   text        not null check (pg_catalog.char_length(output_format) between 1 and 60),   -- the allowlist lives in the module
  full_prompt     text        not null check (pg_catalog.char_length(full_prompt) <= 20000),
  starting_prompt text        not null default '' check (pg_catalog.char_length(starting_prompt) <= 20000),
  origin_kind     text        not null check (origin_kind in ('scratch', 'catalog', 'demo')),
  origin_slug     text        check (origin_slug is null or (origin_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(origin_slug) <= 80)),
  origin_title    text        check (origin_title is null or pg_catalog.char_length(origin_title) <= 200),
  version         integer     not null default 1 check (version >= 1),
  created_at      timestamptz not null default pg_catalog.now(),
  updated_at      timestamptz not null default pg_catalog.now(),
  constraint saved_prompts_origin_slug_iff_catalog check ((origin_kind = 'catalog') = (origin_slug is not null)),
  constraint saved_prompts_request_unique unique (owner_id, request_id),
  constraint saved_prompts_id_owner unique (id, owner_id)
);
create index saved_prompts_by_owner_updated on app.saved_prompts (owner_id, updated_at desc, id desc);

create table app.saved_reflections (
  id               uuid        primary key default pg_catalog.gen_random_uuid(),
  owner_id         uuid        not null references app.accounts (user_id) on delete cascade,
  prompt_id        uuid        not null,
  request_id       uuid        not null,
  request_hash     text        not null check (request_hash ~ '^[0-9a-f]{64}$'),
  request_receipt  jsonb       not null,                                  -- what the ORIGINAL operation answered (see saved_prompts)
  outcome          text        not null check (outcome in ('yes', 'partial', 'no', 'notyet')),
  reflection       text        not null default '' check (pg_catalog.char_length(reflection) <= 4000),
  next_change      text        not null default '' check (pg_catalog.char_length(next_change) <= 500),
  -- WHAT WAS ACTUALLY TRIED: copied by the database from the prompt row at save time and never updated afterwards
  attempted_prompt text        not null check (pg_catalog.char_length(attempted_prompt) <= 20000),
  starting_prompt  text        not null default '' check (pg_catalog.char_length(starting_prompt) <= 20000),
  prompt_title     text        not null check (pg_catalog.char_length(prompt_title) between 1 and 120),
  origin_kind      text        not null check (origin_kind in ('scratch', 'catalog', 'demo')),
  origin_slug      text        check (origin_slug is null or (origin_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(origin_slug) <= 80)),
  origin_title     text        check (origin_title is null or pg_catalog.char_length(origin_title) <= 200),
  prompt_version   integer     not null check (prompt_version >= 1),
  version          integer     not null default 1 check (version >= 1),
  created_at       timestamptz not null default pg_catalog.now(),
  updated_at       timestamptz not null default pg_catalog.now(),
  constraint saved_reflections_request_unique unique (owner_id, request_id),
  constraint saved_reflections_prompt_same_owner foreign key (prompt_id, owner_id) references app.saved_prompts (id, owner_id) on delete cascade
);
create index saved_reflections_by_owner_created on app.saved_reflections (owner_id, created_at desc, id desc);
create index saved_reflections_by_prompt on app.saved_reflections (prompt_id);

alter table app.saved_prompts     enable row level security;
alter table app.saved_reflections enable row level security;
revoke all on app.saved_prompts, app.saved_reflections from public;


reset role;
