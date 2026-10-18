#!/usr/bin/env node
// Stage `preflight` (authorization S6, READ-ONLY): H0 (every target validated, done by the common entry before this runs) and H1a (platform facts).
// This file imports no module that can change hosted state: only the read-only query path and HTTP GET.
import { runStage, checker, ok } from './lib/cli.mjs';
import { queryJson } from './lib/pg.mjs';
import { request } from './lib/http.mjs';
import { FACTS_SQL } from './lib/sql.mjs';

const code = await runStage('preflight', process.argv.slice(2), async ({ ctx, run, flags, profile, say }) => {
  const c = checker(run, say);
  const t = ctx.targets;
  await c.check('H0', 'every target validated before anything was contacted', async () =>
    `ref ${t.ref}; API ${t.url}; migration (direct) login ${t.migrate.user} at ${t.migrate.host}:${t.migrate.port}; pooler login ${t.poolerUser}: txn ${t.txn.host}:${t.txn.port}, session ${t.session.host}:${t.session.port}; worker login ${t.workerUser}`);
  const facts = {};
  await c.check('H1a', 'platform facts through the migration, pooler-session and pooler-transaction endpoints agree and match the expectations', async () => {
    for (const ep of ['migrate', 'session', 'txn']) facts[ep] = await queryJson(ctx, ep, FACTS_SQL, { timeoutMs: 45_000 });
    const f = facts.migrate;
    ok(String(f.server_version).startsWith('17.'), `Postgres major is not 17 (${f.server_version})`);
    ok((f.extensions ?? []).length === 3, 'pgcrypto, citext and pg_trgm are not all available');
    ok(f.postgres_auth_usage === true && f.postgres_sessions_select === true, 'postgres lacks USAGE on schema auth or SELECT on auth.sessions (the session bridge depends on them)');
    if (!flags['allow-existing-schemas'] || profile !== 'selftest') ok((f.app_schemas ?? []).length === 0, `application schemas already exist (${(f.app_schemas ?? []).join(',')}): this is not a fresh project`);
    for (const ep of ['session', 'txn']) ok(facts[ep].version === f.version && facts[ep].public_objects === f.public_objects, `the ${ep} endpoint reports different platform facts than the migration endpoint`);
    const settings = await request(ctx, { path: '/auth/v1/settings' });
    ok(settings.status === 200 && settings.body, `auth settings: HTTP ${settings.status}`);
    if (profile === 'staging') { // the disposable local stack deliberately has sign-ups open; the staging project must not
      ok(settings.body.disable_signup === true, 'public sign-ups are not disabled');
      ok(settings.body.mailer_autoconfirm === false, 'email confirmation is not required (mailer_autoconfirm is true)');
    }
    const jwks = await request(ctx, { path: '/auth/v1/.well-known/jwks.json' });
    const algs = jwks.status === 200 ? (jwks.body?.keys ?? []).map((k) => k.alg ?? k.kty).join(',') : `HTTP ${jwks.status}`;
    const st = run.state(); st.facts.public_objects_before = f.public_objects; st.facts.server_version = f.server_version; st.facts.jwks = algs; run.save(st);
    return `Postgres ${f.server_version}; extensions ${f.extensions.map((e) => `${e.name} ${e.installed ?? 'available'}`).join(', ')}; sign-ups disabled=${settings.body.disable_signup}; autoconfirm=${settings.body.mailer_autoconfirm}; signing keys: ${algs || 'none listed'}; public objects ${f.public_objects}; application schemas present: ${f.app_schemas.length ? f.app_schemas.join(',') : 'none'}`;
  });
  return c.out;
});
process.exitCode = code;
