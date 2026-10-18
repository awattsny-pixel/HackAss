// Interprets the result of one `supabase db push` child process. Pure: the caller runs the CLI (bounded) and passes the result.
export function parsePushResult(r, { dryRun = false } = {}) {
  const what = `supabase db push${dryRun ? ' --dry-run' : ''}`;
  if (r.timedOut) throw new Error(`${what} exceeded its deadline`);
  if (r.truncated) throw new Error(`${what} output was truncated: a result document cannot be trusted`);
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l.trim().startsWith('{'));
  const docs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = docs.find((d) => d.type === 'result')?.data;
  const error = docs.find((d) => d.type === 'error' || d._tag === 'Error');
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${JSON.stringify(error ?? r.stderr.slice(-300)).slice(0, 400)}`);
  if (!result) throw new Error(`${what} printed no result document (exit ${r.code}, ${docs.length} JSON lines, stderr tail: ${r.stderr.slice(-200)})`);
  return result;
}
