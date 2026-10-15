// Builds the environment for the `selftest` profile from the disposable LOCAL Supabase stack. Used only by selftest.mjs and by manual development runs; it can never
// produce a staging environment (the selftest profile accepts only the local stack, the staging profile only the staging project).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const dockerPsql = (sql, dockerBin = process.env.DOCKER_BIN || 'docker') =>
  spawnSync(dockerBin, ['exec', '-i', 'supabase_db_hackass-local', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', timeout: 60_000 });

/** Returns the DISPOSABLE local database to the state of a fresh project: no application schema, role, ledger or auth trigger from the migrations. Local stack only. */
export function resetLocalApplication() {
  const r = dockerPsql(`
    drop schema if exists api, app, app_bridge, app_budget, app_content, app_guard, app_review, worker, supabase_migrations cascade;
    do $$ declare r text; begin
      foreach r in array array['hackass_owner', 'hackass_worker'] loop
        if exists (select 1 from pg_roles where rolname = r) then execute format('drop owned by %I cascade', r); end if;
      end loop;
      foreach r in array array['hackass_worker', 'hackass_owner'] loop
        if exists (select 1 from pg_roles where rolname = r) then execute format('drop role %I', r); end if;
      end loop;
    end $$;`);
  if (r.status !== 0) throw new Error(`could not reset the local application state: ${r.stderr.split('\n')[0]}`);
}
/** The owner action "set the worker password", on the disposable database only. */
export function setLocalWorkerPassword(pw) {
  const r = dockerPsql(`alter role hackass_worker password '${pw}'`);
  if (r.status !== 0) throw new Error('could not set the disposable worker password');
}

export function selftestEnv({ supabaseBin = process.env.SUPABASE_BIN || 'supabase', setPassword = true } = {}) {
  const st = spawnSync(supabaseBin, ['status', '-o', 'json'], { encoding: 'utf8', timeout: 60_000 });
  if (st.status !== 0) throw new Error('the local stack is not running (supabase status failed)');
  const cfg = JSON.parse(st.stdout);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hackass-selftest-pw-'));
  chmodSync(dir, 0o700);
  const workerPw = `wk-${randomBytes(12).toString('hex')}`;
  // the worker has no password in the migrations; in the real flow the OWNER sets one after the migrations. The caller does that with setLocalWorkerPassword (or setPassword: true for dev runs).
  if (setPassword) setLocalWorkerPassword(workerPw);
  const passfile = path.join(dir, 'pgpass');
  writeFileSync(passfile, `host.docker.internal:54322:postgres:postgres:postgres\nhost.docker.internal:54322:postgres:hackass_worker:${workerPw}\n127.0.0.1:54322:postgres:postgres:postgres\n`, { mode: 0o600 });
  chmodSync(passfile, 0o600);
  const apiPort = new URL(cfg.API_URL).port;
  return {
    dir, workerPw,
    env: {
      HOSTED_SELFTEST: '1', STAGING_REF: 'selftest', STAGING_URL: `http://127.0.0.1:${apiPort}`,
      STAGING_MIGRATE_HOST: 'host.docker.internal', STAGING_MIGRATE_PORT: '54322', STAGING_MIGRATE_USER: 'postgres',
      STAGING_POOLER_TXN_HOST: 'host.docker.internal', STAGING_POOLER_TXN_PORT: '54322', STAGING_POOLER_SESSION_HOST: 'host.docker.internal', STAGING_POOLER_SESSION_PORT: '54322',
      STAGING_WORKER_USER: 'hackass_worker', STAGING_PGPASSFILE: passfile,
      STAGING_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY || cfg.ANON_KEY, STAGING_SECRET_KEY: cfg.SECRET_KEY || cfg.SERVICE_ROLE_KEY,
    },
  };
}
