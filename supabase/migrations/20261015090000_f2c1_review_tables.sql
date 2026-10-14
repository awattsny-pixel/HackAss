-- F2-C1 (1/3): moderation records. Three separate, owner-only, append-only tables: risk assessments, source-rights reviews and human
-- decisions. Each row is bound to the exact submission it reviewed: (submission_id, version_id, content_hash, canon_version) is a composite
-- foreign key to the immutable submissions row, so a review of one hash can never be attached to another. Rights reviews additionally name the
-- individual source claim (a foreign key to source_claims) and carry the hash of that claim's canonical line.
-- Nothing here is granted to any role; staff reach it only through the guarded api functions of the third migration.

create schema app_review authorization hackass_owner;

set local role hackass_owner;

revoke all on schema app_review from public;
comment on schema app_review is 'F2-C1: review/decision guards, bindings and approval-eligibility rules. Owner-only.';

-- the binding key: a submission is identified by id AND the exact content it froze
alter table app.submissions add constraint submissions_review_binding unique (id, version_id, content_hash, canon_version);

create table app.version_assessments (
  id            uuid        primary key default pg_catalog.gen_random_uuid(),
  submission_id uuid        not null,
  version_id    uuid        not null,
  content_hash  bytea       not null,
  canon_version smallint    not null,
  seq           integer     not null default 0 check (seq >= 1),          -- assigned by the insert trigger under the submission lock
  risk_class    text        not null check (risk_class in ('low', 'medium', 'high', 'prohibited')),
  rationale     text        not null check (app_content.clean_text(rationale, 10, 2000)),
  assessed_by   uuid        not null references app.accounts (user_id) on delete restrict,
  assessed_at   timestamptz not null default pg_catalog.now(),
  constraint assessments_bound_to_submission foreign key (submission_id, version_id, content_hash, canon_version)
    references app.submissions (id, version_id, content_hash, canon_version) on delete restrict,
  constraint assessments_seq_unique unique (submission_id, seq)
);
comment on table app.version_assessments is 'Staff risk classification of one frozen submission. Append-only; the effective assessment is the highest seq.';

create table app.rights_reviews (
  id            uuid        primary key default pg_catalog.gen_random_uuid(),
  submission_id uuid        not null,
  version_id    uuid        not null,
  content_hash  bytea       not null,
  canon_version smallint    not null,
  claim_no      integer     not null,
  claim_hash    bytea       not null check (pg_catalog.octet_length(claim_hash) = 32),   -- assigned by the trigger: sha-256 of the claim's canonical line
  seq           integer     not null default 0 check (seq >= 1),          -- per (submission, claim)
  status        text        not null check (status in ('clear', 'needs_evidence', 'hold', 'revoked')),
  basis_code    text        check (basis_code in ('staff_original_check', 'source_page_checked', 'license_text_checked', 'permission_on_file', 'public_domain_check', 'author_identity_confirmed')),
  evidence_note text        check (app_content.clean_text(evidence_note, 10, 1000)),
  expires_on    date,
  reviewer_id   uuid        not null references app.accounts (user_id) on delete restrict,
  reviewed_at   timestamptz not null default pg_catalog.now(),
  constraint rights_bound_to_submission foreign key (submission_id, version_id, content_hash, canon_version)
    references app.submissions (id, version_id, content_hash, canon_version) on delete restrict,
  constraint rights_names_a_claim foreign key (version_id, claim_no) references app.source_claims (version_id, claim_no) on delete restrict,
  constraint rights_seq_unique unique (submission_id, claim_no, seq),
  constraint rights_clear_needs_basis_and_evidence check (status <> 'clear' or (basis_code is not null and evidence_note is not null))
);
comment on table app.rights_reviews is 'Staff verification of ONE source claim of one frozen submission. Author declarations never clear rights; only a clear review here does. Append-only; effective = highest seq per claim.';

create table app.moderation_decisions (
  id             uuid        primary key default pg_catalog.gen_random_uuid(),
  submission_id  uuid        not null,
  version_id     uuid        not null,
  content_hash   bytea       not null,
  canon_version  smallint    not null,
  seq            integer     not null default 0 check (seq >= 1),         -- assigned by the trigger under the submission lock
  decision       text        not null check (decision in ('PUBLISH', 'REQUEST_CHANGES', 'REJECT', 'HOLD')),
  reason_codes   text[]      not null default array[]::text[]
                 check (pg_catalog.cardinality(reason_codes) <= 5
                        and reason_codes <@ array['quality', 'safety', 'rights', 'attribution', 'duplicate', 'off_topic', 'spam', 'needs_evidence', 'other']::text[]),
  note           text        check (app_content.clean_text(note, 1, 2000)),
  decided_by_kind text       not null default 'human' check (decided_by_kind = 'human'),   -- automated decisions arrive in their own slice
  actor_id       uuid        not null references app.accounts (user_id) on delete restrict,
  supersedes_id  uuid        references app.moderation_decisions (id) on delete restrict,  -- assigned by the trigger: the previous decision of this submission
  decided_at     timestamptz not null default pg_catalog.now(),
  constraint decisions_bound_to_submission foreign key (submission_id, version_id, content_hash, canon_version)
    references app.submissions (id, version_id, content_hash, canon_version) on delete restrict,
  constraint decisions_seq_unique unique (submission_id, seq),
  constraint decisions_non_publish_needs_reason check (decision = 'PUBLISH' or pg_catalog.cardinality(reason_codes) >= 1)
);
create unique index decisions_one_successor on app.moderation_decisions (supersedes_id) where supersedes_id is not null;   -- the chain is linear: no fork
comment on table app.moderation_decisions is 'Append-only human decisions. seq and supersedes_id are assigned under the submission lock, so the history is one unambiguous chain.';

alter table app.version_assessments enable row level security;
alter table app.rights_reviews      enable row level security;
alter table app.moderation_decisions enable row level security;

reset role;
