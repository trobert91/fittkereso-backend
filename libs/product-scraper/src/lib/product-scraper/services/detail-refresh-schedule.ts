import { createHash } from 'crypto';
import ms from 'ms';
import {
  DETAIL_REFRESH_ONCE,
  FALLBACK_DETAIL_REFRESH_INTERVAL,
  ProductSource,
} from '@fittkereso-backend/database';

/**
 * The share of the interval, at its end, over which listings fall due.
 *
 * A first import writes a whole shop within a day or so, so with one fixed
 * deadline every listing would go stale on the same night, and that run would
 * fetch them all again. Each listing instead falls due somewhere in the last
 * quarter (days 45–60 of 60), by a hash of its URL, and never later than the
 * interval itself.
 */
const SPREAD_SHARE = 0.25;

/** Whether an interval says "read once, never again for its age". */
export function isDetailRefreshOnce(interval: string | null | undefined): boolean {
  return interval?.trim().toLowerCase() === DETAIL_REFRESH_ONCE;
}

/**
 * The source's detailRefreshInterval in ms; undefined for `'once'`, which is
 * never due. An interval it cannot read counts as the 60-day fallback.
 */
export function detailRefreshIntervalMs(
  source: Pick<ProductSource, 'detailRefreshInterval'>,
): number | undefined {
  if (isDetailRefreshOnce(source.detailRefreshInterval)) return undefined;
  const parsed = source.detailRefreshInterval
    ? ms(source.detailRefreshInterval as ms.StringValue)
    : undefined;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ms(FALLBACK_DETAIL_REFRESH_INTERVAL);
}

/**
 * How much earlier than the full interval this listing falls due: the same
 * for a URL on every run, spread evenly over the interval's last quarter.
 */
export function detailRefreshLead(url: string, intervalMs: number): number {
  const hash = createHash('sha1').update(url).digest().readUInt32BE(0);
  return (hash / 2 ** 32) * intervalMs * SPREAD_SHARE;
}

/**
 * When a listing whose detail page was last read at `lastUpdated` falls due
 * again; undefined when it never does (`intervalMs` undefined, i.e. 'once').
 */
export function detailRefreshDueAt(params: {
  url: string;
  lastUpdated: Date;
  intervalMs: number | undefined;
}): Date | undefined {
  const { url, lastUpdated, intervalMs } = params;
  if (intervalMs === undefined) return undefined;
  return new Date(
    lastUpdated.getTime() + intervalMs - detailRefreshLead(url, intervalMs),
  );
}
