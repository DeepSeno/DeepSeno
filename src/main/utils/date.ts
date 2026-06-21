/**
 * Format a Date as a local-timezone YYYY-MM-DD string.
 *
 * Unlike `date.toISOString().split('T')[0]` which returns the UTC date,
 * this always returns the date in the system's local timezone.
 */
export function formatLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
