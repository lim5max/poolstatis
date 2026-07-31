/**
 * PostgreSQL-style calendar month subtraction for UTC timestamps.
 *
 * JavaScript's Date#setUTCMonth overflows at month ends (March 31 - 1 month
 * becomes March 3). PostgreSQL clamps to the final valid day of the target
 * month, which is the policy used by the retention worker.
 */
export function subtractUtcCalendarMonths(value: Date, months: number): Date {
  const targetMonth = value.getUTCMonth() - months;
  const targetYear = value.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(value.getUTCDate(), lastTargetDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}
