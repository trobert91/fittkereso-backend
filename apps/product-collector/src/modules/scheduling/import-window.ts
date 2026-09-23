/**
 * The nightly window imports run in, and the date maths for landing in it.
 *
 * Pure functions with no Nest wiring, because the timezone handling is the
 * easiest thing here to get subtly wrong and it deserves its own tests.
 */

/** Imports run overnight in the shops' local timezone, not the server's. */
export const IMPORT_WINDOW_TIMEZONE = 'Europe/Budapest';
export const IMPORT_WINDOW_START_HOUR = 2;
export const IMPORT_WINDOW_END_HOUR = 6;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * How far `timeZone` is ahead of UTC at the given instant, in ms.
 *
 * Measured from the instant itself rather than hardcoded, so CET/CEST is
 * handled by construction instead of by a +1/+2 that is wrong half the year.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  // Intl can render midnight as hour 24 in some locales/engines.
  const hour = at('hour') % 24;

  const asIfUtc = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    hour,
    at('minute'),
    at('second'),
  );

  return asIfUtc - instant.getTime();
}

/** The calendar date `instant` falls on, in `timeZone`. */
export function zonedYmd(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const at = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  return { year: at('year'), month: at('month'), day: at('day') };
}

/**
 * The UTC instant of a wall-clock time in `timeZone`.
 *
 * Two passes: guess by treating the wall time as UTC and subtracting the offset
 * there, then re-measure at the corrected instant. The second pass matters only
 * on the two DST-change days a year, when the first guess can land on the wrong
 * side of the transition — cheap insurance for a twice-yearly bug that would
 * otherwise put a run an hour outside the window.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour);

  const firstOffset = zoneOffsetMs(new Date(wallAsUtc), timeZone);
  const firstGuess = wallAsUtc - firstOffset;

  const secondOffset = zoneOffsetMs(new Date(firstGuess), timeZone);
  if (secondOffset === firstOffset) return new Date(firstGuess);

  return new Date(wallAsUtc - secondOffset);
}

/**
 * The first import-window start at or after `due`.
 *
 * Snapping is what keeps runs inside the window across intervals: a plain
 * `now + frequency` from an 02:40 run only stays put while nothing drifts, and
 * any frequency that is not a whole number of days walks out of the window
 * within a few runs.
 */
export function nextWindowStart(
  due: Date,
  timeZone: string = IMPORT_WINDOW_TIMEZONE,
): Date {
  const { year, month, day } = zonedYmd(due, timeZone);

  const sameDay = zonedTimeToUtc(
    year,
    month,
    day,
    IMPORT_WINDOW_START_HOUR,
    timeZone,
  );
  if (sameDay >= due) return sameDay;

  // Date.UTC normalises day overflow, so month/year ends need no special case.
  return zonedTimeToUtc(
    year,
    month,
    day + 1,
    IMPORT_WINDOW_START_HOUR,
    timeZone,
  );
}

/**
 * Where inside the window a given source should land.
 *
 * Spreading sources across the four hours rather than firing every shop at
 * 02:00 is the whole politeness budget once there are ten partner shops.
 * `random` is injectable so tests are deterministic.
 */
export function windowOffsetMs(random: () => number = Math.random): number {
  const windowMs = (IMPORT_WINDOW_END_HOUR - IMPORT_WINDOW_START_HOUR) * MS_PER_HOUR;
  // Floored to the minute — sub-minute precision buys nothing and makes
  // stored nextRunAt values harder to read.
  return Math.floor((random() * windowMs) / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** True when `instant` falls inside the window, in `timeZone`. */
export function isInsideWindow(
  instant: Date,
  timeZone: string = IMPORT_WINDOW_TIMEZONE,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
  }).formatToParts(instant);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value) % 24;
  return hour >= IMPORT_WINDOW_START_HOUR && hour < IMPORT_WINDOW_END_HOUR;
}
