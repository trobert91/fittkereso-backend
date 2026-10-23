import { Injectable } from '@nestjs/common';
import {
  ProductImportTaskRepository,
  ProductSource,
  ProductSourceRecordReviewRepository,
  asArukeresoConfig,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { feedFieldsReadBy } from '../arukereso/feed-fields-read-by';
import { FeedSnapshot, FeedSnapshotService } from './feed-snapshot.service';
import { FeedFieldStat, feedFieldChanges, feedFieldStats } from './unread-source-data';
import { LastImportRun, SUMMARY_FEED_ROWS, ShopReviewSummaryService } from './shop-review-summary.service';

const EXAMPLES = 5;

/** A feed checked against what was imported from it. */
export interface FeedCheckResult {
  source: ProductSource;
  lastRun: LastImportRun | null;
  taskStatus: { kind: string; status: string; count: number }[];
  /** Null for a scraping source: it has no feed to fetch. */
  feed: {
    snapshot: FeedSnapshot;
    /** Eligible rows sharing a listing id, which a run collapses into one. */
    repeatedIds: { id: string; rows: number }[];
    repeatedIdTotal: number;
    /** Eligible rows whose listing the source has no record of yet. */
    newListings: { total: number; examples: string[] };
    /** Listings of the source that no eligible row names any more. */
    delisted: { total: number; attached: number; examples: string[] };
    /** Columns of the eligible rows. */
    fields: FeedFieldStat[];
    /** Columns filled now and not in the stored rows, or the other way round. */
    fieldChanges: { appeared: string[]; vanished: string[]; storedRows: number };
    /** The config caps a run (maxItems): new listings are expected then. */
    maxItems?: number;
  } | null;
}

/**
 * Downloads a feed source's feed once (FeedSnapshotService, which keeps it
 * for the listing slices that follow) and compares it with what the source
 * imported: rows by gate outcome, repeated ids, new and delisted listings,
 * columns that appeared or vanished. Nothing written, no LLM call.
 */
@Injectable()
export class FeedCheckService {
  constructor(
    private readonly snapshots: FeedSnapshotService,
    private readonly reviewRepo: ProductSourceRecordReviewRepository,
    private readonly importTaskRepo: ProductImportTaskRepository,
    private readonly summary: ShopReviewSummaryService,
  ) {}

  async check(source: ProductSource): Promise<FeedCheckResult> {
    const [lastRun, taskStatus] = await Promise.all([
      this.summary.lastRun(source.id),
      this.importTaskRepo.statusCounts(source.id),
    ]);
    if (!isFeedSourceType(source.type)) return { source, lastRun, taskStatus, feed: null };
    return { source, lastRun, taskStatus, feed: await this.checkFeed(source) };
  }

  private async checkFeed(source: ProductSource): Promise<NonNullable<FeedCheckResult['feed']>> {
    const config = asArukeresoConfig(source.config, source.name);
    const snapshot = await this.snapshots.load(source, { fresh: true });
    const result: NonNullable<FeedCheckResult['feed']> = {
      snapshot,
      repeatedIds: [],
      repeatedIdTotal: 0,
      newListings: { total: 0, examples: [] },
      delisted: { total: 0, attached: 0, examples: [] },
      fields: [],
      fieldChanges: { appeared: [], vanished: [], storedRows: 0 },
      maxItems: config.maxItems,
    };
    if (!snapshot.reachable) return result;

    const perId = new Map<string, number>();
    for (const row of snapshot.eligible) {
      if (row.listingId) perId.set(row.listingId, (perId.get(row.listingId) ?? 0) + 1);
    }
    const repeated = [...perId.entries()].filter(([, count]) => count > 1);
    result.repeatedIdTotal = repeated.length;
    result.repeatedIds = repeated
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ id, rows: count }));

    const keys = await this.reviewRepo.listingKeys(source.id);
    const known = new Set(keys.map((key) => key.externalId).filter((id): id is string => !!id));
    const fresh = [...perId.keys()].filter((id) => !known.has(id));
    result.newListings = { total: fresh.length, examples: fresh.slice(0, EXAMPLES) };
    const gone = keys.filter((key) => key.externalId && !perId.has(key.externalId));
    result.delisted = {
      total: gone.length,
      attached: gone.filter((key) => key.attached).length,
      examples: gone.slice(0, EXAMPLES).map((key) => key.externalId as string),
    };

    const readers = feedFieldsReadBy(config);
    result.fields = feedFieldStats(snapshot.eligible, readers);
    const stored = await this.importTaskRepo.recentFeedRows({
      sourceId: source.id,
      limit: SUMMARY_FEED_ROWS,
    });
    if (stored.length > 0) {
      const storedFields = feedFieldStats(
        stored.map((row) => ({ fields: (row.item?.['fields'] ?? {}) as Record<string, string> })),
        readers,
      );
      result.fieldChanges = { ...feedFieldChanges(storedFields, result.fields), storedRows: stored.length };
    }
    return result;
  }
}
