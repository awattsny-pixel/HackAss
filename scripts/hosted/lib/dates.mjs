// The owner-confirmed project deletion date: a real calendar date (YYYY-MM-DD), not in the past, not more than a year away.
export class DateRefused extends Error {}
export function validateOwnerDate(value, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) throw new DateRefused('the deletion date must be written YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new DateRefused('the deletion date is not a real calendar date');
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  if (t < today) throw new DateRefused('the deletion date is in the past');
  if (t > today + 366 * 86_400_000) throw new DateRefused('the deletion date is more than a year away');
  return `${m[1]}-${m[2]}-${m[3]}`;
}
/** True for a real calendar date written YYYY-MM-DD (no past/future rule: that applies when the date is recorded). */
export function isCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return false;
  const back = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return back.getUTCFullYear() === Number(m[1]) && back.getUTCMonth() === Number(m[2]) - 1 && back.getUTCDate() === Number(m[3]);
}
