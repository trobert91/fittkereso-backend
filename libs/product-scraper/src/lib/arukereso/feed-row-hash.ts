import { createHash } from 'crypto';
import type { ScrapedProduct } from '@fittkereso-backend/product';
import type { ArukeresoFeedItem } from './arukereso-feed-item';

/**
 * Bump when the mapper's output changes for every row alike — a new field on
 * ScrapedProduct, say — so the next feed run re-imports each row once instead
 * of trusting hashes computed from the old shape.
 *
 * 2: an offer says "none" with null for a mapped field and leaves an unmapped
 * one out (see ScrapedOffer).
 * 3: a mapped row carries only its title (`originalName`); `model` and
 * `displayName` come from the identity extraction alone.
 */
export const FEED_HASH_VERSION = 3;

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

/** One row of a feed task: the raw row, with its listing's key and hash when it was queued. */
export interface FeedEntryRow {
  item: ArukeresoFeedItem;
  /** listingExternalIdOf the mapped row: what a later batch adds rows by. */
  listingId?: string;
  /** feedRowHash of the mapped row. */
  rowHash?: string;
}

/**
 * A feed task's payload: every row of one product page (a bike's sizes can
 * share one URL), the categories its run was narrowed to, and when that run
 * started. The rows are mapped again when the task runs, so a task queued
 * before a config fix imports under the fixed config.
 */
export interface FeedEntryPayload {
  rows: FeedEntryRow[];
  requestedSlugs?: string[];
  /**
   * The feed run that queued the rows, as an ISO timestamp: a later batch of
   * the same run adds its rows of the same page, a later run replaces them.
   */
  runStartedAt?: string;
}

const isFeedItem = (item: unknown): item is ArukeresoFeedItem =>
  !!item &&
  typeof item === 'object' &&
  !!(item as ArukeresoFeedItem).fields &&
  Array.isArray((item as ArukeresoFeedItem).attributes);

/**
 * A feed task's payload, rows first. A task queued before rows were grouped
 * by page carries one row as `{ item }`, and reads as a one-row payload.
 */
export function asFeedEntryPayload(
  payload: Record<string, unknown> | null | undefined,
): FeedEntryPayload | undefined {
  if (!payload) return undefined;
  const requestedSlugs = payload['requestedSlugs'] as string[] | undefined;
  const runStartedAt = payload['runStartedAt'] as string | undefined;

  const rows = payload['rows'];
  if (Array.isArray(rows)) {
    const valid = (rows as FeedEntryRow[]).filter((row) => isFeedItem(row?.item));
    return valid.length > 0 ? { rows: valid, requestedSlugs, runStartedAt } : undefined;
  }

  const item = payload['item'];
  return isFeedItem(item) ? { rows: [{ item }], requestedSlugs, runStartedAt } : undefined;
}

/**
 * A feed task's payloadHash: its one row's feedRowHash — what a task carried
 * before rows were grouped, so an existing task still matches — or, for
 * several rows, a hash of their hashes in sorted order, so the same rows in
 * another order are the same payload.
 */
export function feedPayloadHash(rows: Pick<FeedEntryRow, 'rowHash'>[]): string | undefined {
  const hashes = rows.map((row) => row.rowHash ?? '');
  if (hashes.length === 1) return hashes[0] || undefined;
  return createHash('sha256').update([...hashes].sort().join(',')).digest('hex');
}
