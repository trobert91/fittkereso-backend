import type { ProductReference } from "@ebike-backend/database";

/**
 * Hook the applier invokes after every write to `ProductReference.candidates`
 * so the consuming layer's product registry (or any other thread-scoped cache)
 * stays in sync with the persisted candidate set.
 *
 * Lives in `@ebike-backend/resolution` so the applier can depend on it
 * without depending on `@ebike-backend/thread-processor`. The concrete
 * implementation that wraps `ProductRegistryService` ships from thread-
 * processor and is passed in via `ApplyOptions.registry`.
 *
 * Callsites that don't have a thread-scoped registry (admin overrides,
 * deferred re-resolution, product-merge) simply omit `registry` and the
 * applier no-ops on the registry side.
 */
export interface ResolutionRegistryUpdater {
  /**
   * Invoked after the applier has written (or cleared) `ref.candidates`.
   * `ref.candidates` is guaranteed to reflect the just-persisted state and
   * `ref.ambiguousResolution` is set. Implementations should snapshot off
   * the reference and update their registry entry — no other side effects.
   */
  syncFromReference(ref: ProductReference): void;
}
