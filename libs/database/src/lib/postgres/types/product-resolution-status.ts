/** High-level lifecycle of a `ProductResolution` row — the primary review-queue
 *  filter. Orthogonal to `accepted` (the human verdict) and to the `decisions`
 *  log (the full history); this is the one field that answers "does this still
 *  need attention?".
 *
 *  - `pending` — awaiting a human decision. Default for every new row.
 *  - `done` — decided, and everything that decision implied has been carried out.
 *  - `failed` — decided, but the catalog action errored. Stays visible and
 *    retryable rather than being silently lost.
 *  - `superseded` — replaced by a newer row for the same anchor after the
 *    situation changed. Kept as audit, pruned on retention. */
export enum ProductResolutionStatus {
  pending = 'pending',
  done = 'done',
  failed = 'failed',
  superseded = 'superseded',
}

/** Statuses that still need a human's attention. Also the scope of the partial
 *  unique index on (flow, anchorKey): at most one *open* row per anchor, while
 *  decided/superseded rows for the same anchor accumulate as history. */
export const OPEN_RESOLUTION_STATUSES: ProductResolutionStatus[] = [
  ProductResolutionStatus.pending,
  ProductResolutionStatus.failed,
];
