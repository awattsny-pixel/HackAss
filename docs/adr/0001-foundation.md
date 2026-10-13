# ADR 0001 — Foundation architecture and invariants

Status: accepted direction (CTO, 2026-10-13). F1 (platform skeleton) is implemented; everything below marked **F2+** is a
contract for later slices, not behaviour that exists. Source of truth for the design: `FOUNDATION_DESIGN.md` v2.

## Decisions
1. One Next.js application at the repository root; `/frontend` is held until deployment is confirmed.
2. Postgres via forward-only SQL migrations; transactional rules are SQL functions (RPC), not application read-modify-write.
3. Staff authority is held in the database (`staff_roles`) and re-checked inside each consequential function, together with
   MFA (`aal2` plus a fresh MFA timestamp). Staff do not have individual Postgres login roles.
4. Application runtime database access has exactly three modes — `publicDb`, `userDb`, `workerDb` — and **never the Supabase
   service key**. The worker is the dedicated Postgres login role `hackass_worker` (approved, subject to the real
   connectivity and grant tests in `docs/spikes/f1-hosted-spikes.md`). `service_role`/`postgres` are break-glass only.
5. Zod for validation, Playwright and axe for browser/accessibility tests, k6 for load tests, a 200-result cap on relevance search.
6. Authentication is **server-centric** (the browser never holds a Supabase client). This is an **experiment**: it is not
   validated until the real Auth-flow tests pass (`docs/spikes`, S1–S4). Do not describe it as validated before then.
7. Likes are omitted. Later features (community, ingestion, advertising, commerce) have extension boundaries now and
   tables only in their own milestones.

## What F1 enforces (and what it does not)
Lint rules (module isolation, no database packages under `app/` or `src/ui`, `process.env` only in `src/platform/env.ts`,
no browser Supabase client, `import type`) keep code honest. They are **hygiene, not a security boundary**: the boundary is
the database role and its grants (F2). Environment validation refuses service-level variable names (legacy names are a
warning only while legacy routes exist, pinned by a test). The legacy routes are untouched and remain 503 stubs or the
audited read path.

## Server/client boundary (production-enforced)
Three layers: (1) ESLint import rules and an import-graph test keep `src/ui` and `src/modules` on the client-safe barrel
`src/platform/index.ts`; (2) every server entry point (`env.ts`, `db/*`, `http/handler.ts`, `server.ts`) imports `server-only`, so
**`next build` fails** if one is pulled into a Client Component — proven by `npm run probe:server-boundary` (a server route
importing the surface builds; a Client Component importing it fails with the server-only error), which CI runs as its own job;
(3) pure validation (`env-validate.ts`, `http/validate.ts`, errors, logging) carries no marker and is testable anywhere. The
Node test runner uses `--conditions=react-server` so `server-only` is a no-op *in tests only*; `tests/server-boundary.test.ts`
proves the marker throws without that condition.

## Database invariants (contract for F2; each has a required test in `docs/foundation/f2-acceptance.md`)

**I-1 Frozen content, including children, and serialized with freeze.** After a version's `frozen_at` is set, the database
rejects `INSERT`, `UPDATE` and `DELETE` on `hack_versions` and on every hashed child table (`hack_steps`, `hack_materials`,
`hack_requirements`, `version_tags`, `version_attributions`, `source_claims`, `version_assets`) — including an `UPDATE` that
moves a child row from one version to another (both the old and the new parent must be unfrozen). Draft writes and
`submit_version` take **the same parent lock**: every child write and the freeze first lock the `hack_versions` row (writers
`FOR SHARE`/`FOR UPDATE` as appropriate, the freeze `FOR UPDATE`), and the trigger re-reads `frozen_at` *after* acquiring that
lock. Without this, a child `INSERT` could pass the "not frozen" check, the freeze could commit, and the `INSERT` could then
commit — changing hashed content after the hash was taken. Property to test: for every interleaving of a draft write and a
submit, the stored `content_hash` equals the hash recomputed from the committed rows, and no child row is created after
`frozen_at`.

**I-2 Publication pointer belongs to the hack.** `hacks.current_publication_id` must reference a publication of the *same*
hack: `FOREIGN KEY (current_publication_id, id) REFERENCES publications (id, hack_id)` (with `UNIQUE (id, hack_id)` on
`publications`), in addition to `publications (version_id, hack_id) → hack_versions (id, hack_id)`. A bug in any privileged
function therefore cannot point one hack at another hack's publication or version.

**I-3 Authorization is enforced inside the database for direct RPC calls.** A function callable with a user JWT can be
invoked directly, bypassing any web handler, so a handler calling `getUser()` protects nothing. Every consequential function
re-verifies, in its own transaction: the user exists, is not banned or deleted and has an active profile; the session named
by the JWT's `session_id` claim still exists and has not expired (`auth.sessions`); for staff functions, an active
`staff_roles` row, `aal = aal2`, and a fresh MFA timestamp from the `amr` claim within the step-up window. Local result (real local stack, 2026-10-13): a `SECURITY DEFINER` function owned by the non-superuser `postgres` role can read
`auth.sessions` and sees a signed-out session disappear (this proves `postgres`, not the application owner: `hackass_owner` holds no
privilege on `auth`, because `postgres` cannot delegate USAGE on that schema, so F2-A reaches `auth.sessions` through one `postgres`-owned
bridge function, `app_bridge.session_valid`, and proves the guards under `hackass_owner` — see `docs/db/f2a-authority.md`), `auth.jwt()` exposes `session_id`, `aal` and `amr` with timestamps, and
PostgREST keeps accepting a revoked token, so the in-database check is required. **Hosted** feasibility (spikes S3, S4) is still
unverified; if it fails there, this ADR must be amended before F2 relies on it.

**I-4 Worker effects are bound to the leased subject.** A job carries immutable `job_type`, `subject_type`, `subject_id` and
`subject_hash`; each job type has a declared set of permitted effects. Every worker function takes `(job_id, lease_epoch)`,
locks the job row, verifies the lease (`state = leased`, matching epoch, unexpired) **and** that the effect's target — version,
content hash, submission, decision, publication — equals or derives from the job's bound subject and is permitted for that job
type. `worker.get_job_subject(job_id, lease_epoch)` is the only way the worker reads content: it returns the minimal content
that job type needs, for that job only. The worker role has no general table access.

**I-5 AI budget reservations survive lease expiry.** An expired lease must not release its reservation while the provider
request may still be running and incurring charges. On expiry the reservation becomes `expired_unreconciled` and **stays
counted** against the daily cap until it is reconciled with the provider's actual usage (the reservation id is sent as an
idempotency/reference key) or a conservative horizon passes (longest provider request plus billing delay), after which it is
settled at the full reserved amount. A retry needs a new reservation.

## Invariants carried from v2 (unchanged)
Content hash over a canonical serialization verified by the database; lifecycle separate from frozen content; `shadow_decisions`
physically separate with no publication authority; distinct human and automated publication entry points; the authoritative
kill switch read `FOR SHARE` inside the publishing transaction (a cached flag never authorizes publication); lease fencing
by epoch; atomic budget reservation; withdrawal bound = sum of cache-layer lifetimes, independent of invalidation success;
every privileged function: guard first statement, empty `search_path`, explicit `EXECUTE` grants, conformance test.
