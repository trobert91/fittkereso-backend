/**
 * The product source audit vocabulary.
 *
 * Plain text plus a TS union rather than a pg enum, deliberately: an audit
 * vocabulary grows faster than a schema should be migrated, and adding a value
 * here must not need an ALTER TYPE in lockstep. The column is narrowed by this
 * union at every write, which is where it matters — nothing outside this
 * codebase inserts into the table.
 *
 * Note what is NOT here: the config itself. A `config_version_created` row
 * names the version number, and ProductSourceVersion holds the document. The
 * two tables answer different questions — one is the record that something
 * happened, the other is the thing the next scrape will execute — and copying
 * a config into an audit payload would mean two places to look and two places
 * to disagree.
 */
export const PRODUCT_SOURCE_ACTION_TYPES = [
  /** The source row was created. Payload: { sellerId }. */
  'created',
  /** A new config version was written. Payload: { version, note }. */
  'config_version_created',
  /** An older version was put back, as a new version. Payload: { version, restoredFromVersion }. */
  'config_restored',
  /**
   * A task refused to run this source because its stored config no longer
   * matches the schema. Payload: { version, taskId, kind, url, problems }.
   * Rows written before the ProductImportTask rename carry `queue` instead
   * of `kind`, with the old values (scrape-product-list/-details).
   *
   * Written by the run-time guard, so a broken config is visible on the
   * source's own timeline rather than only inside one failed task's error
   * column, where nobody looks until they already suspect the source.
   */
  'config_validation_failed',
  /** A sync was queued. Payload: { mode, trigger, categoryIds?, brandNames? }. */
  'sync_triggered',
  /** schedulingEnabled changed. Payload: { from, to }. */
  'scheduling_changed',
  /** processingEnabled changed. Payload: { from, to }. */
  'processing_changed',
  /** The owning seller changed. Payload: { from, to, fromLabel, toLabel }. */
  'seller_changed',
  /**
   * An import run finished. Payload: ImportRunSummary plus type and
   * durationMs — { type, itemsSeen, listTasksEnqueued, detailTasksEnqueued,
   * feedTasksEnqueued, tasksReplaced, offersUpdated, duplicateUrls, skipped,
   * failed, durationMs }.
   *
   * A run only queues tasks, so this is its own trace: what it read, what it
   * confirmed in place, and what it queued. Per-item failures are counted
   * rather than written one row each.
   */
  'import_run_completed',
  /** An import run threw. Payload: { type, error, durationMs }. */
  'import_run_failed',
] as const;

export type ProductSourceActionType = (typeof PRODUCT_SOURCE_ACTION_TYPES)[number];
