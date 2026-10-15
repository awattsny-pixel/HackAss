// The stages, their authorization groups (docs/hosted/approval-summary.md S6 to S9), whether they change hosted state, and the order they may run in.
export const STAGES = Object.freeze({
  preflight:        { group: 'S6', mutating: false, needs: [], checks: 'H0, H1a' },
  identity:         { group: 'S7', mutating: true,  needs: ['preflight'], checks: 'H1b' },
  migrate:          { group: 'S7', mutating: true,  needs: ['identity'], checks: 'H2a' },
  exposure:         { group: 'S7', mutating: false, needs: ['migrate'], owner: 'exposure', checks: 'H2b (after the owner exposes api only)' },
  'worker-marker':  { group: 'S7', mutating: true,  needs: ['exposure'], owner: 'worker-password', checks: 'H2c (after the owner sets the worker password)' },
  rerun:            { group: 'S7', mutating: true,  needs: ['worker-marker'], checks: 'H3 (second runner invocation)' },
  inventory:        { group: 'S7', mutating: false, needs: ['rerun'], checks: 'H4, H5a' },
  fixtures:         { group: 'S8', mutating: true,  needs: ['inventory'], checks: 'H5b and the fixture users' },
  'session-checks': { group: 'S8', mutating: true,  needs: ['fixtures'], checks: 'H6, H7, H8' },
  'worker-checks':  { group: 'S8', mutating: true,  needs: ['fixtures', 'worker-marker'], checks: 'H9, H10' },
  'catalog-checks': { group: 'S8', mutating: true,  needs: ['worker-checks'], checks: 'H11' },
  isolation:        { group: 'S8', mutating: false, needs: ['catalog-checks'], checks: 'H12' },
  cleanup:          { group: 'S9', mutating: true,  needs: ['preflight'], checks: 'H13' },
  evidence:         { group: 'S9', mutating: false, needs: ['cleanup'], local: true, checks: 'H14' },
});
export const GROUPS = Object.freeze({ S6: 'read-only', S7: 'mutating', S8: 'mutating', S9: 'mutating' });
export const REREADABLE = new Set(['preflight', 'exposure', 'inventory', 'isolation', 'cleanup', 'evidence']); // read-only stages may be repeated, and so may cleanup (idempotent by construction); other mutating stages run once
