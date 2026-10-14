-- F2-C2 (1/3): private publication records. Publications are immutable, owner-only rows bound by composite foreign keys to the exact hack, version,
-- submission (and its frozen hash), PUBLISH decision and risk assessment they were made from; publication_rights lists the per-claim rights reviews
-- that cleared the claims; publication_withdrawals is the append-only end of a publication. hacks.current_publication_id is the ONE pointer to the
-- publication that is current, and a composite foreign key makes it impossible to point at a publication of another hack.
-- Nothing here is granted to any role; staff reach it only through the guarded api functions of the third migration. No public projection exists.

set local role hackass_owner;

-- ---- keys the publication foreign keys need ----------------------------------------------------------------------------------------------
alter table app.moderation_decisions add constraint decisions_id_submission unique (id, submission_id);
alter table app.version_assessments  add constraint assessments_id_submission unique (id, submission_id);
alter table app.rights_reviews       add constraint rights_review_binding unique (id, submission_id, claim_no, claim_hash);

-- ---- publications --------------------------------------------------------------------------------------------------------------------
create table app.publications (
  id              uuid        primary key default pg_catalog.gen_random_uuid(),
  hack_id         uuid        not null,
  version_id      uuid        not null,
  submission_id   uuid        not null,
  content_hash    bytea       not null,
  canon_version   smallint    not null,
  decision_id     uuid        not null,
  assessment_id   uuid        not null,
  published_by    uuid        not null references app.accounts (user_id) on delete restrict,
  publisher_role  text        not null check (publisher_role in ('reviewer', 'admin')),
  snapshot_format text        not null check (snapshot_format = 'HACKASS-PUB-1'),
  snapshot_text   text        not null,
  snapshot_hash   bytea       not null check (pg_catalog.octet_length(snapshot_hash) = 32),
  published_at    timestamptz not null default pg_catalog.now(),
  constraint publications_id_hack       unique (id, hack_id),
  constraint publications_id_submission unique (id, submission_id),
  constraint publications_one_per_decision unique (decision_id),          -- a PUBLISH decision authorizes at most one publication
  constraint publications_version_of_hack foreign key (version_id, hack_id) references app.hack_versions (id, hack_id) on delete restrict,
  constraint publications_bound_to_submission foreign key (submission_id, version_id, content_hash, canon_version)
    references app.submissions (id, version_id, content_hash, canon_version) on delete restrict,
  constraint publications_decision   foreign key (decision_id, submission_id)   references app.moderation_decisions (id, submission_id) on delete restrict,
  constraint publications_assessment foreign key (assessment_id, submission_id) references app.version_assessments (id, submission_id) on delete restrict
);
create index publications_hack on app.publications (hack_id, published_at desc);
create index publications_submission on app.publications (submission_id);
comment on table app.publications is 'Immutable private publication records. snapshot_text is the HACKASS-PUB-1 canonical text (docs/db/f2c2-publication.md); snapshot_hash its SHA-256.';

create table app.publication_rights (
  publication_id     uuid     not null,
  submission_id      uuid     not null,
  claim_no           integer  not null,
  rights_review_id   uuid     not null,
  claim_hash         bytea    not null,
  evidence_note_hash bytea    not null check (pg_catalog.octet_length(evidence_note_hash) = 32),
  primary key (publication_id, claim_no),
  constraint publication_rights_publication foreign key (publication_id, submission_id) references app.publications (id, submission_id) on delete restrict,
  constraint publication_rights_review foreign key (rights_review_id, submission_id, claim_no, claim_hash)
    references app.rights_reviews (id, submission_id, claim_no, claim_hash) on delete restrict
);
comment on table app.publication_rights is 'The per-claim rights reviews (and the hashes of their claims and evidence notes) that cleared this publication.';

create table app.publication_withdrawals (
  publication_id uuid        primary key references app.publications (id) on delete restrict,
  cause          text        not null check (cause in ('staff', 'superseded', 'review_change')),
  reason_code    text        check (reason_code in ('quality', 'safety', 'rights', 'attribution', 'duplicate', 'off_topic', 'spam', 'other')),
  note           text        check (app_content.clean_text(note, 1, 2000)),
  blockers       text[]      not null default array[]::text[],
  trigger_table  text        check (trigger_table in ('moderation_decisions', 'version_assessments', 'rights_reviews')),
  trigger_id     uuid,
  withdrawn_by   uuid        not null references app.accounts (user_id) on delete restrict,
  withdrawn_at   timestamptz not null default pg_catalog.now(),
  constraint withdrawals_staff_needs_reason check (cause <> 'staff' or reason_code is not null),
  constraint withdrawals_review_change_names_trigger check (cause <> 'review_change' or (trigger_table is not null and trigger_id is not null))
);
comment on table app.publication_withdrawals is 'Append-only end of a publication: who ended it, why, and for review-driven withdrawals which record and which blockers. The publication row itself never changes.';

-- ---- the pointer ---------------------------------------------------------------------------------------------------------------------
alter table app.hacks add column current_publication_id uuid;
alter table app.hacks add constraint hacks_current_publication_of_hack
  foreign key (current_publication_id, id) references app.publications (id, hack_id) on delete restrict;      -- MATCH SIMPLE: NULL = nothing published; a publication can only ever be the pointer of its own hack, so no unique index is needed
comment on column app.hacks.current_publication_id is 'The one current publication of this hack, or NULL. Set only by api.publish_version; cleared only together with a publication_withdrawals row.';

alter table app.publications            enable row level security;
alter table app.publication_rights      enable row level security;
alter table app.publication_withdrawals enable row level security;

reset role;
