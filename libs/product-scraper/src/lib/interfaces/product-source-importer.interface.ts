import { ProductSource, ProductSourceType } from '@fittkereso-backend/database';

export interface ImportRunOptions {
  /** Restrict the run to these category slugs. Empty/omitted means all enabled. */
  categorySlugs?: string[];
}

/**
 * What one import run observed. Recorded on the source's own timeline as an
 * `import_run_completed` action.
 *
 * A feed run batches thousands of items in-process with no ScrapeTask per item,
 * so without this summary it would leave no trace anywhere. Per-item failures
 * are counted here rather than written one row each.
 */
export interface ImportRunSummary {
  /** Items the source offered — feed rows, or product cards across list pages. */
  itemsSeen: number;
  /** Detail-page tasks enqueued. Zero for a feed, and the cost signal for scraping. */
  detailTasksEnqueued: number;
  /** List-page tasks enqueued. Scraping only. */
  listTasksEnqueued: number;
  /** Offers refreshed in place, without a detail scrape. */
  offersUpdated: number;
  /** Items deliberately not imported (category gate, missing identity). */
  skipped: number;
  /** Items that errored. A few is normal; a lot means the config has rotted. */
  failed: number;
}

export const emptyImportRunSummary = (): ImportRunSummary => ({
  itemsSeen: 0,
  detailTasksEnqueued: 0,
  listTasksEnqueued: 0,
  offersUpdated: 0,
  skipped: 0,
  failed: 0,
});

/**
 * One import type's entry point.
 *
 * The two implementations differ in where the work happens, not in contract:
 * scraping fans out into ScrapeTasks and returns as soon as they are queued,
 * while an Árukereső feed completes inline. Both produce ScrapedProducts and
 * hand them to the same downstream persistence path — identity resolution,
 * merge, offer upsert and spec validation are shared and unaware of either.
 */
export interface ProductSourceImporter {
  readonly type: ProductSourceType;

  import(
    source: ProductSource,
    options?: ImportRunOptions,
  ): Promise<ImportRunSummary>;
}
