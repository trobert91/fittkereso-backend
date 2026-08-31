/** Flow-neutral decision state for a `ProductResolution` row — applies uniformly
 *  to both `ProductResolutionFlow` values, not just duplicate-detection pairs.
 *
 *  - `auto_accepted` — the system settled the decision automatically with high
 *    confidence, no review needed. For `duplicate_detection` this also triggers
 *    a merge (tracked via `mergedAt`). For `product_resolution` it means "matched
 *    with high confidence" — no side effect beyond the row itself.
 *  - `pending_review` — needs a human look (ambiguous/uncertain outcome).
 *  - `approved` — a human reviewed a `pending_review` row and confirmed it.
 *    Triggers a merge for `duplicate_detection`; confirmation-only for
 *    `product_resolution`.
 *  - `rejected` — a human reviewed the row and judged it wrong. Confirmation-only
 *    for both flows (duplicate-detection's reject never merged either). */
export enum ProductResolutionDecision {
  auto_accepted = 'auto_accepted',
  pending_review = 'pending_review',
  rejected = 'rejected',
  approved = 'approved',
}
