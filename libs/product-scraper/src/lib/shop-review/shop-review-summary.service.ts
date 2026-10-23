import { Injectable } from '@nestjs/common';
import { uniq } from 'lodash';
import {
  ListingCountRow,
  ProductImportTaskRepository,
  ProductSource,
  ProductSourceActionRepository,
  ProductSourceRecordReviewRepository,
  ProductSourceRepository,
  SavedFieldCountRow,
  categorySectionOf,
  enabledCategorySlugs,
  isArukeresoConfig,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { SpecLabelReaders, specLabelsReadBy } from '@fittkereso-backend/product';
import { feedFieldsReadBy } from '../arukereso/feed-fields-read-by';
import { FeedSnapshotService } from './feed-snapshot.service';
import { CategorySpecCoverage, buildSpecCoverage } from './spec-coverage';
import {
  FeedFieldStat,
  ReviewedSpecLabel,
  StaleMapping,
  feedFieldStats,
  reviewSpecLabels,
  staleMappings,
} from './unread-source-data';

/** Stored feed rows read for the feed-column section. */
export const SUMMARY_FEED_ROWS = 300;

/** The last import run of a source, as its timeline recorded it. */
export interface LastImportRun {
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/** One source's review summary. */
export interface SourceReviewSummary {
  source: ProductSource;
  enabledCategories: string[];
  counts: ListingCountRow[];
  lastRun: LastImportRun | null;
  coverage: CategorySpecCoverage[];
  savedFields: SavedFieldCountRow | null;
  specLabels: ReviewedSpecLabel[];
  staleMappings: StaleMapping[];
  /**
   * Feed sources: the columns of the newest stored feed rows, else of the
   * feed snapshot a feed check left (`origin`). Null for scraping sources.
   */
  feedFields: { origin: 'stored' | 'snapshot' | 'none'; rows: number; fetchedAt?: Date; fields: FeedFieldStat[] } | null;
}

/**
 * What a seller's sources import, measured from what they stored: spec
 * coverage by layer, saved fields, spec rows and feed columns no rule reads,
 * and mapping labels no row carries. Database reads only: no fetch, no LLM.
 */
@Injectable()
export class ShopReviewSummaryService {
  constructor(
    private readonly sourceRepo: ProductSourceRepository,
    private readonly reviewRepo: ProductSourceRecordReviewRepository,
    private readonly importTaskRepo: ProductImportTaskRepository,
    private readonly actionRepo: ProductSourceActionRepository,
    private readonly categoryConfig: CategoryConfigService,
    private readonly snapshots: FeedSnapshotService,
  ) {}

  /** The sources of a seller (by priority, highest first), or one source; each with its seller. */
  async resolveSources(params: { sellerId?: string; productSourceId?: string }): Promise<ProductSource[]> {
    if (params.productSourceId) {
      const source = await this.sourceRepo.repo.findOne({
        where: { id: params.productSourceId },
        relations: { seller: true },
      });
      return source ? [source] : [];
    }
    if (!params.sellerId) return [];
    return this.sourceRepo.repo.find({
      where: { seller: { id: params.sellerId } },
      relations: { seller: true },
      order: { priority: 'DESC' },
    });
  }

  async summarize(params: {
    sellerId?: string;
    productSourceId?: string;
    categorySlug?: string;
  }): Promise<SourceReviewSummary[]> {
    const sources = await this.resolveSources(params);
    if (sources.length === 0) return [];
    const ids = sources.map((source) => source.id);
    const slug = params.categorySlug;
    const [counts, keyRows, savedFields, labelRows] = await Promise.all([
      this.reviewRepo.listingCounts(ids, slug),
      this.reviewRepo.specKeyCounts(ids, slug),
      this.reviewRepo.savedFieldCounts(ids, slug),
      this.reviewRepo.rawSpecLabelCounts(ids, slug),
    ]);

    return Promise.all(
      sources.map(async (source) => {
        const sourceCounts = counts.filter((row) => row.sourceId === source.id);
        const enabled = enabledCategorySlugs(source.config);
        const slugs = uniq([
          ...(slug ? [slug] : enabled),
          ...sourceCounts.map((row) => row.slug).filter((value): value is string => !!value),
        ]).filter((value) => !slug || value === slug);
        const readers = new Map<string, SpecLabelReaders>();
        const readersOf = (category: string | null) => {
          const key = category ?? '';
          if (!readers.has(key)) {
            readers.set(key, specLabelsReadBy(categorySectionOf(source.config, category ?? undefined)));
          }
          return readers.get(key) as SpecLabelReaders;
        };
        const sourceLabels = labelRows.filter((row) => row.sourceId === source.id);

        return {
          source,
          enabledCategories: enabled,
          counts: sourceCounts,
          lastRun: await this.lastRun(source.id),
          coverage: slugs.map((category) => {
            const counted = sourceCounts.find((row) => row.slug === category);
            return buildSpecCoverage({
              slug: category,
              listings: counted?.attached ?? 0,
              products: counted?.products ?? 0,
              rows: keyRows.filter((row) => row.sourceId === source.id && row.slug === category),
              schemaKeys: Object.keys(this.categoryConfig.getJsonSchema(category)?.properties ?? {}),
              config: this.categoryConfig.getConfig(category),
            });
          }),
          savedFields: savedFields.find((row) => row.sourceId === source.id) ?? null,
          specLabels: reviewSpecLabels(sourceLabels, readersOf),
          staleMappings: slugs
            .filter((category) => enabled.includes(category))
            .flatMap((category) => staleMappings(category, readersOf(category), sourceLabels)),
          feedFields: await this.feedFields(source),
        };
      }),
    );
  }

  /** The newest import run outcome on the source's timeline, if any. */
  async lastRun(sourceId: string): Promise<LastImportRun | null> {
    const [actions] = await this.actionRepo.listForSource(sourceId, {
      types: ['import_run_completed', 'import_run_failed'],
      take: 1,
    });
    const action = actions[0];
    return action
      ? { type: action.type, occurredAt: action.occurredAt, payload: action.payload ?? {} }
      : null;
  }

  /**
   * The columns of the source's newest stored feed rows. Finished feed tasks
   * may hold no payload; then the rows of a feed snapshot still fresh from a
   * feed check stand in. Never downloads.
   */
  private async feedFields(source: ProductSource): Promise<SourceReviewSummary['feedFields']> {
    if (!isFeedSourceType(source.type) || !isArukeresoConfig(source.config)) return null;
    const readers = feedFieldsReadBy(source.config);
    const rows = await this.importTaskRepo.recentFeedRows({
      sourceId: source.id,
      limit: SUMMARY_FEED_ROWS,
    });
    if (rows.length > 0) {
      return {
        origin: 'stored',
        rows: rows.length,
        fields: feedFieldStats(
          rows.map((row) => ({ fields: (row.item?.['fields'] ?? {}) as Record<string, string> })),
          readers,
        ),
      };
    }
    const snapshot = this.snapshots.cached(source.id);
    if (snapshot) {
      return {
        origin: 'snapshot',
        rows: snapshot.eligible.length,
        fetchedAt: snapshot.fetchedAt,
        fields: feedFieldStats(snapshot.eligible, readers),
      };
    }
    return { origin: 'none', rows: 0, fields: [] };
  }
}
