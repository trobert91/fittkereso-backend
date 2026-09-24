import { createHash } from 'crypto';
import type { ScrapedProduct } from '@fittkereso-backend/product';
import type { ArukeresoFeedItem } from './arukereso-feed-item';

/**
 * Bump when the mapper's output changes for every row alike — a new field on
 * ScrapedProduct, say — so the next feed run re-imports each row once instead
 * of trusting hashes computed from the old shape.
 */
export const FEED_HASH_VERSION = 1;

/**
 * One feed row as the importer sees it: the MAPPED product at its canonical
 * URL, hashed with sorted keys.
 *
 * Hashed after mapping rather than as raw text on purpose. A row whose raw
 * text changed in a field the config does not read maps to the same product
 * and costs nothing, and a config edit re-imports exactly the rows whose
 * mapped product it changes — not the whole feed.
 */
export function feedRowHash(url: string, scrapedProduct: ScrapedProduct): string {
  return createHash('sha256')
    .update(stableStringify({ version: FEED_HASH_VERSION, url, scrapedProduct }))
    .digest('hex');
}

/** JSON with object keys sorted at every level; undefined values dropped, as JSON does. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : stableStringify(entry))).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/**
 * A feed_entry task's payload: the raw row, and the categories its run was
 * narrowed to. The row is mapped again when the task runs, so a task queued
 * before a config fix imports under the fixed config.
 */
export interface FeedEntryPayload {
  item: ArukeresoFeedItem;
  requestedSlugs?: string[];
}

export function asFeedEntryPayload(
  payload: Record<string, unknown> | null | undefined,
): FeedEntryPayload | undefined {
  const item = payload?.['item'] as ArukeresoFeedItem | undefined;
  if (!item?.fields || !Array.isArray(item.attributes)) return undefined;
  return payload as unknown as FeedEntryPayload;
}
