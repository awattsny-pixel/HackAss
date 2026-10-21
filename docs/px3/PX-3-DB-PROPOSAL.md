# PX-3 database proposal, revision 1 (FOR REVIEW; shown separately from the plan; nothing is a migration or applied)

Revision 1 applies the owner's four corrections and drafts the three previously undrafted functions (see `PX-3-REVISION-1.md`).

Files: `proposed/px3-my-work.draft.sql` (the draft), `proposed/px3-rehearsal.sql` and `proposed/px3-rehearsal-output.txt` (behavioural rehearsal, run in a rolled-back transaction on the disposable local database). The draft is deliberately **outside** `supabase/migrations`.

## 1. Objects
| Object | Kind | Purpose |
|---|---|---|
| `app.saved_prompts` | table (owner `hackass_owner`, RLS on, no policies, no grants) | a saved prompt: title, goal, context, output format (free text 1 to 60; the allowlist lives in the module), full prompt, starting prompt, origin (`scratch`/`catalog`/`demo`, catalog slug and title snapshot), `version`, timestamps, **`request_id` + `request_hash`** (the creating payload's fingerprint) |
| `app.saved_reflections` | table (same) | a result: outcome, reflection, next change, **snapshot of what was tried: `attempted_prompt`, `starting_prompt`, `prompt_title`, origin, `prompt_version`**, `version`, timestamps, `request_id` + `request_hash`; **composite FK `(prompt_id, owner_id)`** to the prompt |
| `app_work` schema | helpers (owner-only): `txt`, `parse_prompt`, `parse_result`, `fingerprint`, `lock_member`, `write_prompt`, `write_result` and two composite types | validation without echoing values, payload fingerprints (SHA-256 of canonical JSON text), per-member advisory lock, and the two write halves shared by the single and combined operations |
| `api.save_prompt`, `get_my_prompt` (with `result_count`), `list_my_prompts`, `delete_my_prompt` (returns `results_deleted`) | exposed | prompts |
| `api.save_reflection(request, prompt, expected_prompt_version, doc)` | exposed | a result against an existing prompt; **refuses a stale prompt version** |
| **`api.save_prompt_and_result(request, prompt_doc, result_doc, id?, expected_version?)`** | exposed | **one transaction**: prompt (create or versioned update) AND result, or nothing |
| `api.update_my_reflection`, `delete_my_reflection` | exposed | edit/delete the member's words (snapshots never change) |
| `api.list_my_results`, `get_my_result` | exposed | read **only** the result's own snapshot columns |
| `api.export_my_data(kind, after_id?, limit?)` | exposed | bounded paged export: `summary` (counts), `prompts`, `results`; at most 50 rows per call; own rows only; no owner id or request hash |
| `app_guard.on_auth_user_deleted_content` + trigger on `auth.users` | trigger | erase a member's content when the Auth user is deleted (the account row stays, marked deleted) |
All eleven `api` functions: SECURITY DEFINER, empty `search_path`, guard first, `EXECUTE` to `authenticated` only.

## 2. Ownership model in the database
Identity only from `app_guard.require_member()` (JWT, live session checked inside the database via the existing bridge, active account); no function accepts an owner id; every read, update and delete filters `owner_id = guard user`; update/delete also require the expected `version` in the same statement; missing and not-yours are both PT404. Tables have RLS enabled **without policies** and **no grants** (`public`, `anon`, `authenticated`, `service_role`, `hackass_worker` all denied); only the `api` functions touch them, as the owner. The composite foreign key makes cross-owner references impossible even for a faulty future writer.

## 3. Behaviour decisions encoded
* **Concurrency:** optimistic `version`; PT409 `version_conflict` (the application turns this into the member's choice).
* **What was tried (correction 1):** `save_reflection` requires the expected prompt version and refuses a different current version; the result stores its own snapshot (tried prompt, starting prompt, title, origin, version) copied by the database; results are read from the snapshot only.
* **Atomic combined save (correction 2):** one function = one transaction; everything is validated before any write; any failure after the prompt write (for example the result quota) rolls the prompt write back.
* **Payload-bound retries (correction 4):** `(owner_id, request_id)` unique **and** `request_hash` stored; an identical retry returns the stored row (for the combined update, even after the prompt has moved on); the same id with different content, parent prompt or expected version is PT409 `request_reuse`.
* **Quotas** (checked under the per-member lock): 100 prompts; 50 reflections per prompt and 500 per member; PT429 `quota_exceeded`.
* **Limits:** title 1 to 120; goal 2,000; context 4,000; full/starting prompt 20,000; reflection 4,000; next change 500; document 128 KiB; unknown keys rejected.
* **Pagination:** keyset `(updated_at, id)` for prompts and `(created_at, id)` for results, limit 1 to 100; the owner filter always applies; the next cursor is only a position.
* **Delete:** hard delete; deleting a prompt cascades its reflections.
* **Errors:** PT404 / PT409 / PT422 (detail = field name only) / PT429, matching F2-B and F2-E conventions. Guard errors 28000 and 42501 as today.
* **No text is interpreted as markup**: stored as plain text; the application renders it as text.

## 4. What the rehearsal showed (and did not)
55 checks passed in a rolled-back transaction on the disposable pilot database (`px3-rehearsal-output.txt`; afterwards the tables and schema did not exist): the four corrections (payload-bound retries accepted/refused; stale prompt version refused; immutable snapshots shown through a parent edit and rename; atomic save incl. rollback after the prompt write; bounded export; cascade count) plus A/B ownership matrix; missing and not-yours are indistinguishable; version conflict and the required version; unknown key, over-long, malformed slug and non-string rejections; keyset pagination without overlap; limit bounds; filter by outcome; direct table access denied to `authenticated`, `anon` and `service_role`; anon and service_role cannot execute the functions; composite FK; quota of 100; a revoked session and a disabled account refused inside the database; cascade on delete; erasure on Auth-user deletion.
**Not shown:** behaviour on the hosted project, true parallel sessions (two connections racing), performance at scale, the F2 golden inventories, PostgREST-level behaviour with real tokens (that is PX-3b's real-stack test).

## 5. Impact on existing assets (to handle in the same change, when approved)
* New forward-only migration(s) and a rollback script following the `supabase/rollbacks` convention (drop order: trigger, functions, tables, `app_work`).
* The golden function inventory and grant tests (`supabase/tests/database/010_roles_and_grants.test.sql`, the G-2 check recorded in the F2 closeout, currently 101 functions) must be extended by the new functions (eleven `api` functions, seven `app_work` helpers and the trigger function: about 19 more, to be confirmed) and by "no table privilege for any role" on the two new tables.
* New DB test file for the ownership matrix and limits (the rehearsal is its starting point).
* A real-stack check script (two members, real JWTs through PostgREST) like the F2 local checks.
* Hosted: applying the migration, hosted verification of the guard path with the new functions, and re-running the exposure check (only schema `api` exposed) are separate, owner-authorized steps.

## 6. Open database questions for the reviewer
1. Hard delete only, or also a short "recently deleted" window? (Recommendation: hard delete.)
2. Are the quota numbers right for a pilot? 3. (Decided: `output_format` stays free text with the allowlist in the module.)
4. Store `origin_title` (a snapshot, so a withdrawn catalog hack still shows its name) or only the slug?
5. Any plan for staff access to member content (recommendation: none)? 6. Backup and retention statement for the privacy text.

## 7. Held
Creating a migration file, applying anything outside the rolled-back rehearsal, any hosted step, commits, pushes, merges, deployment.
