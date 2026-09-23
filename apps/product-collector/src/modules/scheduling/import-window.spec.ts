import {
  IMPORT_WINDOW_END_HOUR,
  IMPORT_WINDOW_START_HOUR,
  IMPORT_WINDOW_TIMEZONE,
  isInsideWindow,
  nextWindowStart,
  windowOffsetMs,
  zonedTimeToUtc,
  zonedYmd,
  zoneOffsetMs,
} from './import-window';

/** The wall-clock time an instant reads as in the import timezone. */
const wallClock = (instant: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: IMPORT_WINDOW_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);

describe('import-window', () => {
  describe('zoneOffsetMs', () => {
    // Budapest is CET (UTC+1) in winter and CEST (UTC+2) in summer. Hardcoding
    // either is wrong half the year, which is the whole reason this is measured.
    it('is +1h in winter and +2h in summer', () => {
      const HOUR = 60 * 60 * 1000;
      expect(
        zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), IMPORT_WINDOW_TIMEZONE),
      ).toBe(HOUR);
      expect(
        zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), IMPORT_WINDOW_TIMEZONE),
      ).toBe(2 * HOUR);
    });
  });

  describe('zonedYmd', () => {
    it('reports the local calendar day, not the UTC one', () => {
      // 23:30 UTC on the 14th is already 00:30 on the 15th in Budapest.
      expect(
        zonedYmd(new Date('2026-01-14T23:30:00Z'), IMPORT_WINDOW_TIMEZONE),
      ).toEqual({ year: 2026, month: 1, day: 15 });
    });
  });

  describe('zonedTimeToUtc', () => {
    it('maps 02:00 local to the right UTC instant in winter', () => {
      const utc = zonedTimeToUtc(2026, 1, 15, 2, IMPORT_WINDOW_TIMEZONE);
      expect(utc.toISOString()).toBe('2026-01-15T01:00:00.000Z');
      expect(wallClock(utc)).toBe('15/01/2026, 02:00');
    });

    it('maps 02:00 local to the right UTC instant in summer', () => {
      const utc = zonedTimeToUtc(2026, 7, 15, 2, IMPORT_WINDOW_TIMEZONE);
      expect(utc.toISOString()).toBe('2026-07-15T00:00:00.000Z');
      expect(wallClock(utc)).toBe('15/07/2026, 02:00');
    });

    it('normalises day overflow across a month boundary', () => {
      const utc = zonedTimeToUtc(2026, 1, 32, 2, IMPORT_WINDOW_TIMEZONE);
      expect(wallClock(utc)).toBe('01/02/2026, 02:00');
    });
  });

  describe('nextWindowStart', () => {
    it('returns the same day when due is before the window', () => {
      // 00:30 Budapest on the 15th.
      const due = new Date('2026-01-14T23:30:00Z');
      expect(wallClock(nextWindowStart(due))).toBe('15/01/2026, 02:00');
    });

    it('rolls to the next day when due is after the window', () => {
      // 14:00 Budapest on the 15th — past that day's 02:00.
      const due = new Date('2026-01-15T13:00:00Z');
      expect(wallClock(nextWindowStart(due))).toBe('16/01/2026, 02:00');
    });

    it('rolls across a month boundary', () => {
      const due = new Date('2026-01-31T13:00:00Z');
      expect(wallClock(nextWindowStart(due))).toBe('01/02/2026, 02:00');
    });

    it('returns due itself when it is exactly the window start', () => {
      const exact = zonedTimeToUtc(2026, 1, 15, 2, IMPORT_WINDOW_TIMEZONE);
      expect(nextWindowStart(exact).getTime()).toBe(exact.getTime());
    });

    // The two days a year the naive one-pass offset calculation is wrong.
    it('stays inside the window on the spring-forward day, when 02:00 does not exist', () => {
      // Budapest springs forward on 2026-03-29: the clock jumps 01:59 -> 03:00,
      // so there IS no 02:00 that day. Landing at 03:00 is the correct answer
      // and is still inside the 02:00-06:00 window — the run happens, an hour
      // later than usual, rather than being skipped or thrown.
      const due = new Date('2026-03-28T13:00:00Z');
      const start = nextWindowStart(due);

      expect(wallClock(start)).toBe('29/03/2026, 03:00');
      expect(isInsideWindow(start)).toBe(true);
    });

    it('lands on 02:00 local across the autumn DST transition', () => {
      // Budapest falls back 2026-10-25 (01:00 UTC).
      const due = new Date('2026-10-24T13:00:00Z');
      expect(wallClock(nextWindowStart(due))).toBe('25/10/2026, 02:00');
    });
  });

  describe('windowOffsetMs', () => {
    it('never pushes past the end of the window', () => {
      const windowMs =
        (IMPORT_WINDOW_END_HOUR - IMPORT_WINDOW_START_HOUR) * 60 * 60 * 1000;

      expect(windowOffsetMs(() => 0)).toBe(0);
      // Just under 1 — the largest value Math.random can return.
      expect(windowOffsetMs(() => 0.9999999)).toBeLessThan(windowMs);
    });

    it('is a whole number of minutes', () => {
      for (const r of [0.1, 0.33, 0.5, 0.87, 0.99]) {
        expect(windowOffsetMs(() => r) % 60_000).toBe(0);
      }
    });

    it('keeps a snapped run inside the window for any jitter value', () => {
      const due = new Date('2026-01-15T13:00:00Z');
      const start = nextWindowStart(due);

      for (const r of [0, 0.25, 0.5, 0.75, 0.9999999]) {
        const at = new Date(start.getTime() + windowOffsetMs(() => r));
        expect(isInsideWindow(at)).toBe(true);
      }
    });
  });

  describe('isInsideWindow', () => {
    it('is true at the start hour and false at the end hour', () => {
      expect(
        isInsideWindow(zonedTimeToUtc(2026, 1, 15, 2, IMPORT_WINDOW_TIMEZONE)),
      ).toBe(true);
      expect(
        isInsideWindow(zonedTimeToUtc(2026, 1, 15, 5, IMPORT_WINDOW_TIMEZONE)),
      ).toBe(true);
      expect(
        isInsideWindow(zonedTimeToUtc(2026, 1, 15, 6, IMPORT_WINDOW_TIMEZONE)),
      ).toBe(false);
      expect(
        isInsideWindow(zonedTimeToUtc(2026, 1, 15, 14, IMPORT_WINDOW_TIMEZONE)),
      ).toBe(false);
    });

    it('judges by local time, not UTC', () => {
      // 02:00 UTC in summer is 04:00 Budapest — inside. 02:00 Budapest is
      // 00:00 UTC, which a UTC-based check would call outside.
      expect(isInsideWindow(new Date('2026-07-15T00:00:00Z'))).toBe(true);
      expect(isInsideWindow(new Date('2026-07-15T05:00:00Z'))).toBe(false);
    });
  });
});
