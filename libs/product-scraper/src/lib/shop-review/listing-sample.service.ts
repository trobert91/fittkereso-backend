import { Injectable } from '@nestjs/common';
import {
  ProductImportTaskRepository,
  ProductSource,
  ProductSourceRecord,
  ProductSourceRecordReviewRepository,
  categorySectionOf,
  isArukeresoConfig,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { SpecLabelReaders, specLabelsReadBy } from '@fittkereso-backend/product';
import { urlGroupKey } from '@fittkereso-backend/utils';
import { feedFieldsReadBy } from '../arukereso/feed-fields-read-by';
import { ArukeresoFeedItem } from '../arukereso/arukereso-feed-item';
import { ReviewedListing, reviewListing } from './listing-review';
import { NON_SPEC_SCHEMA_KEYS } from './spec-coverage';
import { FeedSnapshot, FeedSnapshotService } from './feed-snapshot.service';

/**
 * Where a listing's raw feed row comes from: `auto` the row its last import
 * stored, else a fresh feed snapshot if one is cached (never downloads);
 * `live` the feed snapshot, downloading the feed once if none is cached;
 * `none` no feed row.
 */
export type FeedRowMode = 'auto' | 'live' | 'none';

export const LISTING_SAMPLE_MAX = 50;
const DESCRIPTION_LIMIT = 400;

export interface ListingSample {
  source: ProductSource;
  /** Listings in the ordered set the slice is cut from. */
  total: number;
  offset: number;
  listings: ReviewedListing[];
  /** Feed sources: how many listings got their feed row stored, from the snapshot, or not at all. */
  feedRows: { stored: number; snapshot: number; missing: number; snapshotFetchedAt?: Date } | null;
}

/**
 * A slice of a source's stored listings, each next to the raw data it was
 * built from (its spec rows, its stored feed row) and its product. Database
 * reads only: no fetch, no LLM.
 */
@Injectable()
export class ListingSampleService {
  constructor(
    private readonly reviewRepo: ProductSourceRecordReviewRepository,
    private readonly importTaskRepo: ProductImportTaskRepository,
    private readonly categoryConfig: CategoryConfigService,
    private readonly snapshots: FeedSnapshotService,
  ) {}

  async sample(params: {
    source: ProductSource;
    categorySlug?: string;
    offset: number;
    limit: number;
    includeUnattached?: boolean;
    feedRows?: FeedRowMode;
  }): Promise<ListingSample> {
    const { source } = params;
    const { total, records } = await this.reviewRepo.listingSlice({
      sourceId: source.id,
      categorySlug: params.categorySlug,
      includeUnattached: params.includeUnattached,
      offset: params.offset,
      limit: Math.min(params.limit, LISTING_SAMPLE_MAX),
    });

    const readers = new Map<string, SpecLabelReaders>();
    const readersOf = (slug: string | undefined) => {
      const key = slug ?? '';
      if (!readers.has(key)) readers.set(key, specLabelsReadBy(categorySectionOf(source.config, slug)));
      return readers.get(key) as SpecLabelReaders;
    };
    const feedReaders =
      isFeedSourceType(source.type) && isArukeresoConfig(source.config)
        ? feedFieldsReadBy(source.config)
        : null;

    const mode = params.feedRows ?? 'auto';
    const wantsFeed = !!feedReaders && mode !== 'none';
    let snapshot: FeedSnapshot | null =
      wantsFeed && mode === 'live' && records.length > 0
        ? await this.snapshots.load(source)
        : wantsFeed
          ? this.snapshots.cached(source.id)
          : null;
    if (snapshot && !snapshot.reachable) snapshot = null;
    const counts = { stored: 0, snapshot: 0, missing: 0 };

    const listings: ReviewedListing[] = [];
    for (const record of records) {
      const slug = record.scrapedProduct?.category?.slug;
      let feedItem: Pick<ArukeresoFeedItem, 'fields'> | null = null;
      if (wantsFeed) {
        feedItem = mode === 'auto' ? await this.storedFeedItem(source, record) : null;
        if (feedItem) counts.stored += 1;
        else {
          const row = record.externalId ? snapshot?.byListingId.get(record.externalId) : undefined;
          feedItem = row ? { fields: row.fields } : null;
          if (feedItem) counts.snapshot += 1;
          else counts.missing += 1;
        }
      }
      listings.push(
        reviewListing({
          record,
          readers: readersOf(slug),
          schemaKeys: Object.keys(this.categoryConfig.getJsonSchema(slug)?.properties ?? {}).filter(
            (key) => !NON_SPEC_SCHEMA_KEYS.includes(key),
          ),
          feedItem,
          feedReaders: wantsFeed ? feedReaders : null,
          descriptionLimit: DESCRIPTION_LIMIT,
        }),
      );
    }
    return {
      source,
      total,
      offset: params.offset,
      listings,
      feedRows: wantsFeed ? { ...counts, snapshotFetchedAt: snapshot?.fetchedAt } : null,
    };
  }

  /** The feed row the listing's newest import stored, found as a re-import finds it. */
  private async storedFeedItem(
    source: ProductSource,
    record: ProductSourceRecord,
  ): Promise<Pick<ArukeresoFeedItem, 'fields'> | null> {
    if (!record.url) return null;
    const stored = await this.importTaskRepo.latestFeedPayload({
      sourceId: source.id,
      url: record.url,
      urlKey: urlGroupKey(record.url),
      listingId: record.externalId,
    });
    const item = stored?.payload?.['rows']?.[0]?.item as Partial<ArukeresoFeedItem> | undefined;
    return item?.fields ? { fields: item.fields } : null;
  }
}
