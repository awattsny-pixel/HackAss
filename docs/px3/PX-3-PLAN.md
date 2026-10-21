# PX-3 plan, revision 1: private saving of prompts and reflections, and "My results" (PLAN ONLY; nothing implemented, no migration created)

Revision 1 follows the owner's review of 2026-10-20: decisions recorded in section 10; four corrections applied (what was actually tried, one-transaction "Save prompt and result", editor revisions while saving, create retries bound to their payload); privacy wording qualified; the three undrafted functions drafted. See `PX-3-REVISION-1.md` for the focused delta.

Branch for the later build: from the accepted PX-2c state. The database changes are shown **separately** in `PX-3-DB-PROPOSAL.md` with a draft SQL file that is **not** in `supabase/migrations`. No commit, push, merge, hosted action or deployment is implied. Saving, AI and payments are different slices: PX-3 sends nothing to any AI service.

## 1. Bounds
**In:** a signed-in member can save the prompt they are working on, save the result of trying it (a reflection), reopen and edit their saved prompts, see **My results**, and delete any of it; ownership enforced in the application **and** the database; clear loading/empty/error/denied/conflict/outage states; focused tests.
**Out:** sharing or publishing (everything is private to its owner; no staff access), AI features and spend, payments, autosave, folders/tags/search, import, teams, public profiles, analytics on content, member MFA, any change to the catalog or review system, hosted changes.

## 2. What already exists and is reused
| Piece | Use in PX-3 |
|---|---|
| PX-2 sessions: T2 = Auth server confirmed, the setup gate, bounded body reader, throttle (single-instance), same-origin check, no-store, uniform errors | every PX-3 request is T2 (private **read** and **write**), same-origin, body-bounded, throttled for writes |
| `app_guard.require_member()` (verified session, live account) and the `api` function conventions (SECURITY DEFINER, empty `search_path`, guard first, PT404/PT409/PT422/PT429) | the database re-checks identity on **every** call, whatever the application did |
| Experience state in `ExperienceProvider` (draft fields, full prompt, starting prompt, reflection, dirty flag, confirmations) | the Save buttons read it; "Continue editing" writes into it (with the existing overwrite confirmation) |
| UX-08 shell, `StateBox`, 44 px controls, toast, the sign-in screen and indicator | all new screens |
| `createUserDb` (cookie client; the member's JWT reaches PostgREST) | the only database client the new handlers use; no service key |
**Does not exist yet:** any table for member content; any member-scoped API function; any "My ..." screen.

## 3. Product behaviour
* **Save** (Lab): explicit button, no autosave. States: *Not saved*, *Saving…*, *Saved* (with time), ***Changed since last save***, *Couldn't save — your draft is still here* (retry), *Saved elsewhere — choose* (conflict), *Sign in to save* (links to sign-in, which keeps the draft). First save creates; later saves update that prompt (expected version). **Save as new copy** is always available. Saving never clears or alters the working draft.
* **Editor revisions while saving (correction 3).** Every edit advances a monotonic *draft revision* in the experience state. A Save captures the revision (and the exact content) it submits. A successful response marks **only that revision** as saved (`savedRevision = max(savedRevision, submitted)`); if the member typed while the request was running, the draft is still newer than what was saved: the state shows "Changed since last save" and the **leave-page warning stays on**. A failed save changes nothing (still dirty). A response for a revision older than the one already saved is ignored. Only one save is in flight at a time; a later Save uses the latest revision. If the response to an **update** is lost and the retry meets a version conflict, the client fetches the saved prompt and treats the save as done only when its content equals what was submitted; otherwise the conflict choice is shown. Regression tests: delayed-response reducer tests like the session-race ones (typing during a save; out-of-order responses; failure; conflict-after-lost-response).
* **Save this result / Save prompt and result** (Reveal): if the prompt is already saved and unchanged, `save_reflection` with the prompt version the member tried; if it is not saved or has changed, **one operation** `save_prompt_and_result`: the database stores the prompt (created, or updated at the expected version) **and** the result in a single transaction, so a failure cannot leave a half-completed save (rehearsed: a failure after the prompt write rolls the prompt back). A result records **what was actually tried**: the database copies the prompt text, the starting prompt, the title, the origin and the prompt version into the result at save time, and refuses a result whose expected prompt version is no longer current (the member tried an older text in another tab). Results and My results never read those from the mutable parent. One **request id** binds a Save intent: an identical retry is accepted and returns what was stored; the same id with different content, parent or version is refused, so the UI can never report work as saved that was not.
* **My prompts** (`/account/prompts`) and **My results** (`/account/results`): lists (newest first, "Load more", result filter by outcome), detail pages (a result shows the starting prompt, the prompt tried, the reflection and the next change **as they were when saved**), **Continue editing** (loads into the Lab; confirmation if the current draft has unsaved changes), **Delete** with a confirmation that states the cascade: *"Deleting this prompt also permanently deletes its N saved results. This can't be undone."* (N from `get_my_prompt`), **Download my data** (bounded, paged export).
* **Conflicts:** if the saved copy changed elsewhere (another tab or device) the member chooses: *load the saved version*, *save mine as a copy*, or *overwrite* (explicit confirmation). Nothing is lost silently.
* **Outage and expiry:** a failed or unverifiable save is a retryable message; the draft is never discarded; if the session ended, sign-in keeps the draft by client navigation (PX-2c) and the member presses Save again.
* **Unsaved-work guard:** the leave-page warning applies only while there are changes that are not saved; "Saved" clears it.
* **Plain language (PROVISIONAL, to be finalized before external testers):** at the Save button: *"Private to your account; not shared with other members. Please don't store passwords or other secrets in prompts."* The wording deliberately does **not** say "only you can see it" or "no human access": privileged database operators and backups are outside these application restrictions, and the final privacy text must say so.

## 4. Ownership and security model (three independent layers)
1. **Application:** a T2 check (the Auth server confirms the session) before any private read or write; the owner is never taken from a request; ids from the client are only ever used together with the guard's identity; responses are explicit allowlists; no content in logs or errors.
2. **Database function:** every function starts with `app_guard.require_member()` (identity from the verified JWT, session still alive inside the database, account active); every statement filters by `owner_id = the guard's user`; update and delete name ownership **and** version in the same statement; "not yours" and "does not exist" are the same PT404.
3. **Database structure:** tables have RLS on with **no policies** and **no grants to anyone** (deny by default even if a grant is added by mistake); a composite foreign key makes it impossible for a reflection to reference another owner's prompt; no staff, worker or service access to member content.
| Threat | Control |
|---|---|
| Reading or changing another member's content by guessing ids (IDOR) | owner filter in every statement; random UUIDs; PT404 identical for missing and not-yours; verified by an A/B matrix |
| Mass assignment (sending `owner_id`, `version`, `created_at`) | unknown keys rejected (`assert_keys`); the owner comes only from the guard |
| Lost updates and double submits | `version` checked in the same statement (PT409); create idempotency key `(owner, request_id)` |
| Storage abuse | per-field limits, 128 KiB document cap, quotas (100 prompts; 50 reflections per prompt, 500 per member), bounded request body (streaming limit + deadline), application write throttle |
| Revoked session or disabled account still working | the guard re-checks the session and account in the database on every call |
| Cursor tampering | keyset cursor is only a position; the owner filter is applied with or without it |
| Direct table access through the API | only schema `api` is exposed; tables hold no grants; RLS without policies |
| Content leaking through logs, errors, URLs | log events by name only; errors carry a field name never a value; ids in paths only; no content in query strings |
| Stale or cross-tab overwrites | version conflicts surface to the member (section 3); no silent last-writer-wins |
| A result describing a text the member did not try | expected prompt version required; the result snapshots prompt, starting prompt, title and origin |
| A partial save (prompt stored, result lost) | one database operation, one transaction |
| A retry that reports success for different content | request ids bound to a payload fingerprint (PT409 `request_reuse`) |
| Newer typing marked as saved | save acknowledges only the submitted revision (section 3) |
| Cross-site request forgery | same-origin check on every mutation (existing) |

## 5. Data and API (summary; details in the DB proposal)
Two private tables (`saved_prompts`, `saved_reflections`) and **eleven** `api` functions, all drafted: save/get/list/delete prompt; `save_reflection` (expected prompt version required); **`save_prompt_and_result`** (atomic); update/delete result; list/get results; a **bounded, paged export** (`export_my_data`: summary, prompts, results; at most 50 rows per call). Erasure when an Auth user is deleted (a trigger; the account row stays marked deleted). All rehearsed (section 9).
**Application layer (held):** a new module (proposed name `mywork`; adding it requires updating the module-layout test) with pure validation (output-format allowlist, limits, request ids) and an injected RPC client like the catalog module; route handlers under `/work/...` (JSON; GET list/detail, POST create, PUT update, DELETE) wrapped like the auth handlers (origin check, T2 + setup gate, bounded body of 128 KiB for prompts, throttle for writes, no-store, uniform errors, PT-code to HTTP mapping: 404/409/422/429, outages 503 without touching cookies).

## 6. Screens (approved UX-08 design; no redesign)
Lab: Save area with the states above. Reveal: Save this result. `/account/prompts`, `/account/prompts/[id]`, `/account/results`, `/account/results/[id]`: list/detail/empty/loading/error/denied/conflict/delete-confirmation/outage states, mobile and desktop, 44 px controls, keyboard operable, the sidebar/topbar chip unchanged. Sign-in required: a calm "Sign in to see your saved work" state (no redirect that discards a draft).

## 7. Privacy, retention, deletion
Everything is private to the owner. Kept until the member deletes it or the account is deleted (then erased by the trigger). Hard delete, no "recently deleted" bin. Backups and the provider's retention are outside the application and must be described honestly in the privacy text (owner/legal; hosted details unconfirmed). No analytics, no AI processing, no human access in PX-3; any future support access must be a separate, audited function. Members can export their own data. Content is plain text rendered as text (never as HTML).

## 8. Slices and acceptance
| Slice | Content | Acceptance |
|---|---|---|
| PX-3a (held: needs migration approval) | migration + rollback script from the draft; DB tests | ownership matrix (A/B), anon/service_role denied, revoked session and disabled account denied, version conflict, **payload-bound idempotent creates**, **stale prompt version refused for results**, **snapshots immutable**, **atomic save rolls back on any failure**, limits and quotas, cascade with count, composite FK, export paging and allowlists, erasure trigger, grants and golden-function inventory updated |
| PX-3b | `mywork` module + handlers; real-stack integration (two members, local pilot stack) | T2 required for every route (outage = 503, never T1), cross-owner attempts all 404, concurrency (two parallel updates: one 409), body limits and throttles, no content in logs, CSRF refused |
| PX-3c | UI: Save, Save prompt and result, My prompts, My results, export | save/reload/sign-out/sign-in round trips keep or restore work; **editor-revision regressions (typing during a save stays dirty, leave-page warning kept)**; conflict flows; draft preserved on every failure; cascade-warning delete; empty/error/denied states; desktop + mobile; keyboard; 44 px |
| PX-3d | review package; hosted staging verification (separately authorized) | focused diff, results, screenshots; hosted checks listed in the DB proposal |

## 9. Evidence gathered (planning only)
The revised draft SQL was compiled and **rehearsed in a transaction that was rolled back** on the disposable local pilot database (nothing persisted; verified afterwards: neither table nor the helper schema exists): **55 checks pass** (`proposed/px3-rehearsal-output.txt`). Beyond the revision-0 checks (A/B ownership matrix, identical PT404, version conflicts, unknown-key and limit rejections, pagination, grants, guard refusals, erasure) they now cover: identical create retries accepted and different content / parent / expected version refused; a result against a stale prompt version refused; the result keeps the tried prompt, the starting prompt, title and version after the parent is edited and renamed, and My results shows the snapshot title; the combined save creates both, fails whole on an invalid result, and **rolls the prompt update back when the result quota trips after the prompt write**; identical retry of a combined update after the prompt moved on; editing a result leaves its snapshot untouched; bounded export (pages without overlap, no owner or request fields, limits); delete reports and removes the result count. This is **not** a migration and **not** acceptance.

## 10. Decisions (approved 2026-10-20 unless marked)
| Decision | Approved direction |
|---|---|
| Saving | Explicit Save; no autosave |
| Pilot quotas | 100 prompts, 50 results per prompt, 500 results per member |
| Deletion | Hard delete with confirmation and a clear cascade warning |
| Staff access | No staff-facing access |
| Export | A bounded self-service export |
| Module | `mywork` |
| Demo-origin prompts | Allowed, retaining the demo attribution |
| Output formats | Module allowlist; the database keeps only structural length limits |
| Privacy wording | **Provisional**; finalize (including operators and backups) before external testers |

## 11. Risks and open items
Hosted behaviour of the new functions, backups and provider retention are unverified. The throttle is single-instance. Cross-tab conflicts are handled by versions, but the UX of conflict choices needs a browser pass. The Auth items from PX-2 remain prerequisites for external testers (SMTP, real HTTPS cookie verification, hosted settings). Artwork rights stay a public-release gate.

## 12. Held
Implementation of saving, any migration file, applying anything to a database other than the rolled-back local rehearsal, commits, pushes, merges, hosted changes, deployment, AI, payments.
