import type { ProductModel } from '@fittkereso-backend/database';
import type { ResolutionContext } from './resolution-context';

/**
 * What `ResolutionService.search()` returns.
 *
 * - `resolvedModel`: the full TypeORM `ProductModel` entity when the search
 *   resolved to a catalog product. Undefined when the decision was unresolved.
 * - `context`: the persisted v2 context. Always present.
 * - `confidence`: unified 0–100 integer confidence. Mirrors
 *   `context.decision?.confidence` for caller convenience.
 * - `resolutionRecordId`: the `ProductResolution` row this decision was logged
 *   to, when it cleared the recording threshold. The scraper uses it to link the
 *   row back to the `ProductSourceRecord` once that exists — recording happens
 *   before the listing is persisted, so the FK can only be set afterwards.
 */
export interface ResolutionResult {
  resolvedModel?: ProductModel;
  context: ResolutionContext;
  confidence: number;
  resolutionRecordId?: string;
}

/**
 * Optional recording metadata for `search()`. Kept out of `ResolutionOptions`
 * on purpose: options are persisted into the row's `inputSnapshot` and consumed
 * by the pipeline stages, whereas this only tells the recorder which real-world
 * situation the decision belongs to.
 */
export interface ResolutionRecordingContext {
  /** Identifies the situation being decided, enabling idempotent re-recording. */
  anchorKey?: string;
  /** Set when the scraped listing is already persisted (a re-scrape). */
  sourceRecordId?: string;
}
