import { ProductModel, ProductSource, ScrapeTask } from '@fittkereso-backend/database';

/**
 * Everything the persistence path needs about "where this product came from",
 * independent of how it arrived.
 *
 * The path used to take a ScrapeTask directly, which is fine while every
 * product comes from a page fetch — but an Árukereső feed run batches thousands
 * of items in-process with no ScrapeTask per item, and inventing throwaway task
 * rows purely to satisfy a signature would put fake work in a table the workers
 * poll.
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
   * The originating task, on the scrape path only.
   *
   * Its presence is what gates the writeback of `task.product` and
   * `task.identityDecision` — a feed run has nothing to write back to.
   */
  task?: ScrapeTask;
}

/** The scrape path's context: everything derives from the task itself. */
export const contextFromTask = (task: ScrapeTask): ProductImportContext => ({
  source: task.source,
  url: task.url,
  // ScrapeTask.product is nullable; the context distinguishes only set/unset.
  product: task.product ?? undefined,
  force: task.force,
  task,
});
