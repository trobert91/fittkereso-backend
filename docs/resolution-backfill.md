# Resolution Backfill

Resolution Backfill is the reference-driven system that **re-resolves product references against the growing catalog and category set over time** — without ever reprocessing a thread. It replaces the old "deferred resolution" module (`apps/review-collector/src/modules/deferred-resolution/`, now removed), which conflated a flat-interval retry with a category-enablement path that re-ran full thread extraction.

## Core idea

A reference is **unresolved** iff it has no `ProductReferenceCandidate` rows. The backfill treats all unresolved references uniformly — there is no "deferred" flag (it was removed; the disabled-category state is derived from `productCategory.extractionEnabled`). A reference becomes resolvable as the world changes:

- its **category** is created → the resolve step matches its `categoryHint` and links it lazily; is **enabled** → it becomes eligible automatically (the ref already points at the category row, so the candidate query stops excluding it);
- the **product** is added to the catalog → the next backfill pass re-resolves the ref and finds it;
- a **group member** (same `productLinkId`) resolves → its candidates are copied to the rest of the group.

## `productLinkId` — same-product groups

The identification LLM tags each product with a `linkId` letter (`"A"`, `"B"`, …); all mentions of the same exact product in one response share a letter. We persist it as a per-batch `productLinkId` UUID **seed**, which the in-memory `ProductRegistry` then **overrides** on a registry hit so the same product shares one `productLinkId` across subtrees (even when unresolved). Within a thread, the group's primary resolves once (with the whole group's pooled specs/clues) and the rest inherit its candidate set. At end-of-thread, any product resolved anywhere in the thread is propagated to its still-unresolved group members.

## The scheduled job

Module: `apps/review-collector/src/modules/resolution-backfill/`. An hourly cron (`ResolutionBackfillScheduler`) runs a single resolution pass (`ResolutionBackfillService`):

- `findBackfillCandidates` returns the `topN` highest-priority eligible unresolved refs: no candidates, `enabled`, category resolvable, `attemptResolutionAfter <= NOW()`, `createdAt` within `retryMaxAgeDays`, **and the ref's comment is review-bound** — `status IN (APPROVED, IN_REVIEW)` with `relevance >= minApprovalScore`. `IN_REVIEW` is included on purpose: moderation parks unresolved-high-relevance refs there (`SubtreeModerationService.deriveDecision`), and those are exactly what backfill resolves. Refs whose comment is `DELETED`/`SKIPPED` or below the approval floor are skipped — resolving them would never produce a review.
- **Priority = highest relevance first.** Ordering is `relevance DESC, attemptResolutionAfter ASC NULLS FIRST, createdAt ASC` (relevance primary; longest-waited and oldest break ties). There is **no computed score and no full-table sort**: a partial composite index (`ix_product_reference_backfill` on `(relevance, attemptResolutionAfter, createdAt) WHERE enabled = true`) lets Postgres walk the eligible slice in rank order and stop at `limit` — fast even at millions of references. The residual filters (unresolved `NOT EXISTS`, category, age, indexed `comment.status` + `comment.relevance`) are applied while walking.
- A miss backs the ref off (growing, capped); it never gives up *within the age window*, so a product catalogued later is still picked up on the ref's next eligible run — but a ref older than `retryMaxAgeDays` (default 365) drops out of the candidate set, abandoning stale backlog rather than churning it forever.
- **Category identified lazily.** Before resolving, a ref with no `productCategory` but a `categoryHint` is matched against the enabled categories (`identifyCategoryIfMissing`) and linked if found — there is no separate reconciliation pass. Enabling a category needs nothing extra: a ref already linked to it passes the candidate query the moment `extractionEnabled` flips true (`productCategoryId IS NULL OR category.extractionEnabled = true`), and a null-category ref is always eligible and gets identified when it comes up.
- Each attempt replays the enriched input pooled with the group's evidence, sets `attemptResolutionAfter = now + effectiveCooldown(resolutionAttemptCount)` (growing, capped — **no give-up**), and on a match copies candidates to the productLinkId group.
- **Review creation is delegated, not called.** Backfill never invokes the review builder. On a resolve it (1) **re-moderates** the ref's comment with the shared `CommentModerationDecisionService.decide` (the same rule moderation uses) — resolution drops the unresolved-ref severity/trigger, so an `IN_REVIEW` comment held only for this ref flips to `APPROVED`; a comment still holding another unresolved high-relevance ref or a real validation issue correctly stays `IN_REVIEW` — and (2) **touches** the comment (`status` ← new decision, `lastProcessedStatus = NULL`, bump `updatedAt`) in one targeted `update`. The every-minute `CommentReviewSchedulerService` then builds the review naturally (Trigger A for a first review now that the comment is `APPROVED`; Trigger C for an existing one via the bumped `ref.updatedAt`), and `ProductRatingScheduler` recomputes ratings off `review.updatedAt`. The same resolve → re-moderate → touch runs for each `productLinkId` sibling.
- **Catalog-only** — backfill always resolves embedding-only (`webSearchEnabled: false`), never web search. The catalog is the only thing that changed since the original resolution, so a re-run against it is the whole point; web search stays confined to the live extraction pipeline.

## Config

`libs/config/src/lib/configs/scheduling.json` → `resolutionBackfill` (typed in `dynamic-config-data.interface.ts`):

```json
"resolutionBackfill": {
  "enabled": true,
  "scoredResolution": {
    "topN": 50, "retryMaxAgeDays": 365,
    "cooldown": { "baseCooldownHours": 168, "backoffBase": 2, "maxCooldownHours": 2160 }
  }
}
```

## Relevant `ProductReference` fields

`productLinkId` (same-product group), `resolutionAttemptCount` (drives the backoff), `attemptResolutionAfter` (next-eligible time, NULL = now), `resolutionFinished`, `relevance`, `candidates`. (`resolutionDeferred` and `groupingKey` were removed.)
