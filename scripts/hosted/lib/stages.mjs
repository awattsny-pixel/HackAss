// The stages, their authorization groups (docs/hosted/approval-summary.md S6 to S9), whether they change hosted state, and the order they may run in.
// `isolation` is classed as mutating: it creates Auth sessions for the fixture users and POSTs to private functions that WOULD run if isolation were broken.
export const STAGES = Object.freeze({
  preflight:        { group: 'S6', mutating: false, needs: [], checks: 'H0, H1a' },
  adopt:            { group: 'S6', mutating: false, needs: [], checks: 'A1 to A4 (inherits preflight, identity and migrate from an earlier run; read-only)' },
  identity:         { group: 'S7', mutating: true,  needs: ['preflight'], checks: 'H1b' },
  migrate:          { group: 'S7', mutating: true,  needs: ['identity'], checks: 'H2a' },
  exposure:         { group: 'S7', mutating: false, needs: ['migrate'], owner: 'exposure', checks: 'H2b (after the owner exposes api only)' },
  'worker-marker':  { group: 'S7', mutating: true,  needs: ['exposure'], owner: 'worker-password', checks: 'H2c (after the owner sets the worker password)' },
  rerun:            { group: 'S7', mutating: true,  needs: ['worker-marker'], checks: 'H3 (second runner invocation)' },
  inventory:        { group: 'S7', mutating: false, needs: ['rerun'], checks: 'H4, H5a' },
  fixtures:         { group: 'S8', mutating: true,  needs: ['inventory'], checks: 'H5b and the fixture users' },
  'session-checks': { group: 'S8', mutating: true,  needs: ['fixtures'], checks: 'H6, H7, H8 (H8-default with --default-window)' },
  'worker-checks':  { group: 'S8', mutating: true,  needs: ['fixtures', 'worker-marker'], checks: 'H9, H10' },
  'catalog-checks': { group: 'S8', mutating: true,  needs: ['worker-checks'], checks: 'H11' },
  isolation:        { group: 'S8', mutating: true,  needs: ['catalog-checks'], checks: 'H12' },
  cleanup:          { group: 'S9', mutating: true,  needs: ['preflight'], checks: 'H13' },
  evidence:         { group: 'S9', mutating: false, needs: [], local: true, checks: 'H14' },
});
export const GROUPS = Object.freeze({ S6: 'read-only', S7: 'mutating', S8: 'mutating', S9: 'mutating' });
/** Read-only stages may be repeated when done, and so may cleanup (idempotent by construction) and evidence; every other stage runs once per run. */
export const REREADABLE = new Set(['preflight', 'exposure', 'inventory', 'cleanup', 'evidence']);
/** The only stages that may run while any stage is failed, interrupted or unfinished, or after cleanup has closed the run. */
export const RECOVERY = new Set(['cleanup', 'evidence']);
/** Read-only stages that may be re-attempted after THEIR OWN failure, only with --retry-after-review (a named, recorded decision), and only if no other stage is unhealthy. */
export const RETRYABLE_AFTER_REVIEW = new Set(['preflight', 'exposure', 'inventory']);
/** Stage order for reporting, and the checks a complete run must have passed. H8-default is the hosted 15-minute MFA test. */
export const REQUIRED_CHECKS = Object.freeze([
  ['preflight', ['H0', 'H1a']], ['identity', ['H1b']], ['migrate', ['H2a']], ['exposure', ['H2b']], ['worker-marker', ['H2c']], ['rerun', ['H3']], ['inventory', ['H4', 'H5a']],
  ['fixtures', ['FX0', 'H5b', 'FX1']], ['session-checks', ['H6', 'H7', 'H8', 'H8-default']], ['worker-checks', ['H9', 'H9b', 'H10']], ['catalog-checks', ['H11']],
  ['isolation', ['H12a', 'H12b', 'H12c']], ['cleanup', ['H13a', 'H13b', 'H13c']],
]);
