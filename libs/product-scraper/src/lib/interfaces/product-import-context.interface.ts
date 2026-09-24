import { ProductModel, ProductSource, ProductImportTask } from '@fittkereso-backend/database';

/**
 * Everything the persistence path needs about "where this product came from",
 * independent of how it arrived: a scraped page or a feed row, each in its own
 * ProductImportTask, plus what only one of them carries (a feed row's hash).
 *
 * Nothing downstream of here changes: identity resolution, merge, spec
 * validation and offer upsert are shared and unaware of which importer called.
 */
export interface ProductImportContext {
  source: ProductSource;

  /** The product's own URL — ProductSourceRecord identity. */
  url: string;

  /**
   * Pins identity resolution to this product (Path 1), skipping the matcher.
   * Set when the caller already knows which product this is — a refresh of a
   * known listing, say.
   */
  product?: ProductModel;

  /** Bypasses the spec-hash caches, forcing the LLM post-process to re-run. */
  force?: boolean;

  /**
   * The originating task. Every import has one now that feed rows are tasks
   * too; only scripts and simulations call without.
   *
   * Its presence is what gates the writeback of `task.product` and
   * `task.identityDecision`.
   */
  task?: ProductImportTask;

  /**
   * A feed row's hash (see feedRowHash), stored on its listing so the next
   * feed run can tell the row unchanged. Unset on the scrape path.
   */
  feedRowHash?: string;
}

/** The scrape path's context: everything derives from the task itself. */
export const contextFromTask = (task: ProductImportTask): ProductImportContext => ({
  source: task.source,
  url: task.url,
  // ProductImportTask.product is nullable; the context distinguishes only set/unset.
  product: task.product ?? undefined,
  force: task.force,
  task,
});
