import { ProductSource, ProductSourceType } from '@fittkereso-backend/database';

/**
 * Why a run of a source that lists the whole catalog (hasAllProducts) removed
 * no offers although it would have: it saw only part of the catalog (capped,
 * filtered, narrowed to some categories, rows that failed to map), the
 * removal is switched off, or it would have removed too many to trust.
 */
export type RemovalSkipReason =
  | 'capped'
  | 'filtered'
  | 'narrowed'
  | 'mapping_failures'
  | 'disabled'
  | 'share_exceeded';

export interface ImportRunOptions {
  /** Restrict the run to these category slugs. Empty/omitted means all enabled. */
  categorySlugs?: string[];
}

/**
 * What one import run observed. Recorded on the source's own timeline as an
 * `import_run_completed` action.
 *
 * A run only queues work — tasks import the products afterwards — so this is
 * the run's own trace: what it read, what it confirmed in place, what it
 * queued. Per-item failures are counted here rather than written one row each.
 */
export interface ImportRunSummary {
  /** Items the source offered — feed rows, or product cards across list pages. */
  itemsSeen: number;
  /** Detail-page tasks enqueued. Zero for a feed, and the cost signal for scraping. */
  detailTasksEnqueued: number;
  /** List-page tasks enqueued. Scraping only. */
  listTasksEnqueued: number;
  /** Feed rows queued as new feed_entry tasks: new, changed, or missing their offer. Feed only. */
  feedTasksEnqueued: number;
  /** Still-pending feed_entry tasks whose row changed, given the new row instead. Feed only. */
  tasksReplaced: number;
  /** Offers refreshed in place — an unchanged feed row, say — without any task. */
  offersUpdated: number;
  /** Feed rows sharing a URL with an earlier row: the last one wins. Feed only. */
  duplicateUrls: number;
  /** Items deliberately not imported (category gate, missing identity). */
  skipped: number;
  /** Items that errored. A few is normal; a lot means the config has rotted. */
  failed: number;
  /**
   * This source's listings waiting unattached when the run ended: rows of a
   * source that does not identify products, whose offer its seller's
   * identifying source has not written. Feed only; zero for an identifying
   * source. The run only queues its rows, so rows it queued are not counted
   * yet: a first run reports none, and get_product_source_import_status has
   * the live count.
   */
  unattachedRecords?: number;
  /**
   * Offers of the seller the run did not see, removed because the source
   * lists the whole catalog (hasAllProducts). Set only for such a source.
   */
  offersRemoved?: number;
  /** Why such a run removed nothing. Set only when it skipped the removal. */
  removalSkipped?: RemovalSkipReason;
}

export const emptyImportRunSummary = (): ImportRunSummary => ({
  itemsSeen: 0,
  detailTasksEnqueued: 0,
  listTasksEnqueued: 0,
  feedTasksEnqueued: 0,
  tasksReplaced: 0,
  offersUpdated: 0,
  duplicateUrls: 0,
  skipped: 0,
  failed: 0,
});

/**
 * One import's entry point, for the source types it lists: the feed importer
 * runs both `arukereso` and `googleshop`.
 *
 * Both implementations only queue ProductImportTasks and return: scraping
 * queues its list pages, a feed run its new or changed rows. The tasks then
 * produce ScrapedProducts for the same downstream persistence path — identity
 * resolution, merge, offer upsert and spec validation are shared and unaware
 * of either.
 *
 * `source` must arrive with its `seller` loaded: a feed run looks up the
 * existing offers of its rows by (seller, externalId).
 */
export interface ProductSourceImporter {
  readonly types: readonly ProductSourceType[];

  import(
    source: ProductSource,
    options?: ImportRunOptions,
  ): Promise<ImportRunSummary>;
}
