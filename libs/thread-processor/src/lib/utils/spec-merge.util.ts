import { ProductReference, StructuredSpec } from "@ebike-backend/database";

export interface MergeDiscoveredSpecsResult {
  hasNewSpecs: boolean;
  newSpecs: StructuredSpec[];
}

/**
 * Spec discovery for the extraction phase.
 *
 * Filters raw LLM specs by valid spec names, deduplicates against the
 * authoritative ref.specs array, and — when new specs are found — appends
 * them to ref.specs, records the filtered set on ref.context.extraction, and
 * sets newSpecsDiscovered=true to trigger post-extraction re-resolution.
 */
export function mergeDiscoveredSpecs(
  ref: ProductReference,
  rawSpecs: StructuredSpec[],
  validSpecNames: Set<string>,
): MergeDiscoveredSpecsResult {
  const filteredSpecs =
    validSpecNames.size > 0
      ? rawSpecs.filter((s) => validSpecNames.has(s.name))
      : rawSpecs;

  if (filteredSpecs.length === 0) {
    return { hasNewSpecs: false, newSpecs: [] };
  }

  const existingSpecNames = new Set((ref.specs ?? []).map((s) => s.name));
  const newSpecs = filteredSpecs.filter((s) => !existingSpecNames.has(s.name));

  if (newSpecs.length === 0) {
    return { hasNewSpecs: false, newSpecs: [] };
  }

  // Append to the authoritative specs array
  ref.specs = [...(ref.specs ?? []), ...newSpecs];

  // Record on the extraction container with the re-resolution flag
  ref.context.extraction = {
    ...ref.context.extraction,
    specs: filteredSpecs,
    newSpecsDiscovered: true,
  };

  return { hasNewSpecs: true, newSpecs };
}
