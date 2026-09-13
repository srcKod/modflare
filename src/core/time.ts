/**
 * Timezone-aware time helpers for schedule gating.
 *
 * Cron triggers fire on UTC; features that publish "at 09:00 local time" use
 * these to convert the wall clock into the configured IANA timezone. DST is
 * handled by Intl (no manual offsets).
 */

/** Resolve the 0-23 hour of `now` in `timeZone`. Falls back to UTC on bad tz. */
export function hourInTz(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isNaN(hour) ? now.getUTCHours() : hour;
}

/**
 * Range check with cross-midnight support: start=22, end=6 → active 22:00-06:00.
 * start === end means the full 24-hour window.
 */
export function isHourInRange(hour: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
