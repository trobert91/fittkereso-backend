import { ProductSpecs, StructuredSpec } from "@ebike-backend/database";
import { isNil } from "lodash";
import { structuredSpecsToProductSpecs } from "./spec-utils";

/**
 * Restrict a ProductSpecs map to the keys listed in primarySpecs.
 * Returns a new object containing only those keys whose values are not nil.
 *
 * When primarySpecs is undefined or empty, returns an empty object — there's
 * no category-defined primary spec set to filter on.
 */
export function pickPrimarySpecs(
  specs: ProductSpecs | undefined,
  primarySpecs: string[] | undefined,
): ProductSpecs {
  const result: ProductSpecs = {};
  if (!specs || !primarySpecs || primarySpecs.length === 0) {
    return result;
  }
  for (const key of primarySpecs) {
    const value = specs[key];
    if (!isNil(value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Compute the per-dimension match conditions a candidate must satisfy.
 *
 * = referenceSpecs ∩ primarySpecs, overlaid by inputSpecs ∩ primarySpecs.
 *
 * Per-dimension override semantics — when a key appears in both the reference
 * and the input, the input wins. Keys outside `primarySpecs` are ignored on
 * both sides.
 *
 * - Reference set, no comment overrides → returns the reference's primary specs.
 *   (The trigger case: 34" reference, comment doesn't contradict any spec, so
 *   `effectiveMatchSpecs.screenSize === '34"'` is inherited.)
 * - Reference set, comment overrides one dimension ("the 39 inch version") →
 *   that dimension takes the comment value, others stay inherited.
 * - No reference → returns just `inputSpecs ∩ primarySpecs`.
 * - Comment override on a non-primary key → ignored (gate only enforces primarySpecs).
 */
export function computeEffectiveMatchSpecs(
  referenceSpecs: ProductSpecs | undefined,
  inputSpecs: StructuredSpec[] | undefined,
  primarySpecs: string[] | undefined,
): ProductSpecs {
  const fromReference = pickPrimarySpecs(referenceSpecs, primarySpecs);
  const inputAsMap = structuredSpecsToProductSpecs(inputSpecs);
  const fromInput = pickPrimarySpecs(inputAsMap, primarySpecs);

  // Per-dimension overlay — input wins where both are present.
  return { ...fromReference, ...fromInput };
}
