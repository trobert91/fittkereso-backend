import type { ProductModel } from "@ebike-backend/database";
import type { ResolutionContext } from "./resolution-context";

/**
 * What `ResolutionService.search()` returns.
 *
 * - `resolvedModel`: the full TypeORM `ProductModel` entity when the search
 *   resolved to a catalog product. Undefined when the decision was unresolved.
 * - `context`: the persisted v2 context. Always present.
 * - `confidence`: unified 0–100 integer confidence. Mirrors
 *   `context.decision?.confidence` for caller convenience.
 */
export interface ResolutionResult {
  resolvedModel?: ProductModel;
  context: ResolutionContext;
  confidence: number;
}
