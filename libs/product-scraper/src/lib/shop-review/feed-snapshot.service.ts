import { Injectable } from '@nestjs/common';
import { Transform } from 'stream';
import { ProductSource, asArukeresoConfig } from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import { listingExternalIdOf } from '@fittkereso-backend/utils';
import { ArukeresoProductMapperService } from '../arukereso/arukereso-product-mapper.service';
import { ArukeresoFeedParserService } from '../arukereso/arukereso-feed-parser.service';

/** How long a downloaded feed is reused by later review calls. */
export const FEED_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
/**
 * Feeds held at once, the oldest dropped first: enough for a review of every
 * seller. Column values are cut at FIELD_VALUE_MAX, so a large feed's eligible
 * rows take a few MB.
 */
const MAX_SNAPSHOTS = 12;
const FIELD_VALUE_MAX = 500;

/** One eligible feed row: the listing it becomes and its top-level columns. */
export interface FeedSnapshotRow {
  listingId: string | null;
  slug: string;
  fields: Record<string, string>;
}

/** A feed as downloaded once, gated, and kept for a while. */
export interface FeedSnapshot {
  sourceId: string;
  url: string;
  fetchedAt: Date;
  reachable: boolean;
  error?: string;
  /** From the request until the response stream opened (headers in). */
  openMs?: number;
  /** From the request until the first body byte. */
  firstByteMs?: number;
  totalMs?: number;
  bytes?: number;
  format?: string;
  rows: number;
  /** Rows by outcome: `eligible:<slug>`, or the skip reason. */
  outcomes: Record<string, number>;
  /** The rows that pass the gate, in feed order. */
  eligible: FeedSnapshotRow[];
  /** Eligible rows by listing id; a repeated id keeps its last row, as a run does. */
  byListingId: Map<string, FeedSnapshotRow>;
}

/**
 * Downloads a feed source's feed, runs only the free category gate on every
 * row (classify) plus its externalId and url targets, and keeps the eligible
 * rows for FEED_SNAPSHOT_TTL_MS: a feed check, then any number of listing
 * slices, cost one download. Concurrent loads of one feed share the
 * download. No full mapping, no LLM call, nothing written.
 */
@Injectable()
export class FeedSnapshotService {
  private readonly snapshots = new Map<string, FeedSnapshot>();
  private readonly loading = new Map<string, Promise<FeedSnapshot>>();

  constructor(
    private readonly scraperService: ScraperService,
    private readonly feedParser: ArukeresoFeedParserService,
    private readonly mapper: ArukeresoProductMapperService,
  ) {}

  /** The feed's snapshot when one is fresh, without downloading. */
  cached(sourceId: string): FeedSnapshot | null {
    const snapshot = this.snapshots.get(sourceId);
    if (!snapshot) return null;
    if (Date.now() - snapshot.fetchedAt.getTime() > FEED_SNAPSHOT_TTL_MS) {
      this.snapshots.delete(sourceId);
      return null;
    }
    return snapshot;
  }

  /** The fresh snapshot, else one download (shared with any load already running). */
  async load(source: ProductSource, options: { fresh?: boolean } = {}): Promise<FeedSnapshot> {
    if (!options.fresh) {
      const cached = this.cached(source.id);
      if (cached) return cached;
    }
    const running = this.loading.get(source.id);
    if (running) return running;
    const loading = this.download(source).finally(() => this.loading.delete(source.id));
    this.loading.set(source.id, loading);
    const snapshot = await loading;
    if (snapshot.reachable) this.keep(snapshot);
    return snapshot;
  }

  private keep(snapshot: FeedSnapshot): void {
    this.snapshots.delete(snapshot.sourceId);
    this.snapshots.set(snapshot.sourceId, snapshot);
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  private async download(source: ProductSource): Promise<FeedSnapshot> {
    const config = asArukeresoConfig(source.config, source.name);
    const snapshot: FeedSnapshot = {
      sourceId: source.id,
      url: config.feedUrl,
      fetchedAt: new Date(),
      reachable: false,
      rows: 0,
      outcomes: {},
      eligible: [],
      byListingId: new Map(),
    };
    const startedAt = Date.now();
    try {
      const { stream, contentType } = await this.scraperService.stream(config.feedUrl, source.fetchMode);
      snapshot.openMs = Date.now() - startedAt;
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (bytes === 0) snapshot.firstByteMs = Date.now() - startedAt;
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      stream.on('error', (error) => counter.destroy(error));
      const parsed = await this.feedParser.parseStream(
        stream.pipe(counter),
        async (item) => {
          snapshot.rows += 1;
          const classified = await this.mapper.classify(config, item);
          const outcome =
            classified.status === 'skipped' ? classified.reason : `eligible:${classified.slug}`;
          snapshot.outcomes[outcome] = (snapshot.outcomes[outcome] ?? 0) + 1;
          if (classified.status === 'skipped') return;

          const url = await this.mapper.resolveTarget(config, item, 'url');
          const externalId = await this.mapper.resolveTarget(config, item, 'externalId');
          const listingId = url
            ? listingExternalIdOf(
                { externalId: externalId == null ? null : String(externalId) },
                String(url),
              )
            : null;
          const row: FeedSnapshotRow = { listingId, slug: classified.slug, fields: cutValues(item.fields) };
          snapshot.eligible.push(row);
          if (listingId) snapshot.byListingId.set(listingId, row);
        },
        {
          format: config.format ?? 'auto',
          delimiter: config.csv?.delimiter ?? 'auto',
          contentType,
        },
      );
      snapshot.reachable = true;
      snapshot.bytes = bytes;
      snapshot.format = parsed.format;
    } catch (error: unknown) {
      snapshot.error = error instanceof Error ? error.message : String(error);
    }
    snapshot.totalMs = Date.now() - startedAt;
    return snapshot;
  }
}

/** The row's columns with long values (descriptions) cut, to bound a kept feed's memory. */
function cutValues(fields: Record<string, string>): Record<string, string> {
  const cut: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    cut[name] = typeof value === 'string' && value.length > FIELD_VALUE_MAX ? `${value.slice(0, FIELD_VALUE_MAX)}…` : value;
  }
  return cut;
}
