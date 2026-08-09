import { normalize } from "@ebike-backend/utils";
import type { ProductResolutionInput } from "../models/resolution-input";
import type { ModelVariant } from "../models/resolution-context";

export interface BuildModelVariantsOptions {
  /** Resolved brand name (from Stage 1 or 2). Drives `brand_strip`. */
  brandName?: string;
  /** Hard cap on returned variants. */
  maxModelVariants: number;
}

/**
 * Generate model-variant seeds for recall strategies.
 *
 * Pure string transforms — no I/O. The recall strategies call this directly with
 * the resolved brand name and the `search.maxModelVariants` knob from
 * DynamicConfig.
 *
 * Variant sources (in order of attempt):
 *  - `original`            — `input.model` verbatim
 *  - `suffix_strip`        — drop trailing single-letter suffix (e.g. "34GS95QE-B" → "34GS95QE")
 *  - `normalization`       — collapse letter↔digit spaces ("MPG 341CQPX" → "MPG341CQPX")
 *  - `brand_strip`         — drop the brand prefix when it leads the model
 *  - `reference_model`     — `input.referenceModel` (cheat-sheet token) — fallback when no input.model
 *  - `identification_clue` — `input.modelClues[*]` — partial codes the LLM extracted
 *
 * Deduplication is normalized (lowercase, whitespace-collapsed) so variants that
 * differ only in casing collapse to one.
 */
export function buildModelVariants(
  input: ProductResolutionInput,
  options: BuildModelVariantsOptions,
): ModelVariant[] {
  const { brandName, maxModelVariants } = options;
  const originalModel = input.model?.trim() ?? "";
  const candidates: ModelVariant[] = [];

  if (originalModel) {
    candidates.push({ model: originalModel, source: "original" });

    const suffixStripped = originalModel.replace(/[-/][a-zA-Z]$/i, "");
    if (suffixStripped !== originalModel) {
      candidates.push({ model: suffixStripped, source: "suffix_strip" });
    }

    const normalized = originalModel
      .replace(/([a-zA-Z])\s+(\d)/g, "$1$2")
      .replace(/(\d)\s+([a-zA-Z])/g, "$1$2");
    if (
      normalized !== originalModel &&
      !candidates.some((variant) => variant.model === normalized)
    ) {
      candidates.push({ model: normalized, source: "normalization" });
    }

    if (brandName) {
      const normalizedBrand = normalize(brandName);
      const normalizedModel = normalize(originalModel);
      if (
        normalizedModel.startsWith(normalizedBrand + " ") ||
        normalizedModel.startsWith(normalizedBrand)
      ) {
        const stripped = originalModel.slice(brandName.length).trim();
        if (
          stripped &&
          !candidates.some((variant) => variant.model === stripped)
        ) {
          candidates.push({ model: stripped, source: "brand_strip" });
        }
      }
    }
  }

  // Reference-product fallback seeds: when the comment named no model of its own,
  // fall back to the upstream `referenceModel` and any `modelClues` extracted by
  // identification.
  const referenceModel = input.referenceModel?.trim();
  if (
    referenceModel &&
    !candidates.some((variant) => variant.model === referenceModel)
  ) {
    candidates.push({ model: referenceModel, source: "reference_model" });
  }
  for (const clue of input.modelClues ?? []) {
    const trimmed = clue.trim();
    if (!trimmed || candidates.some((variant) => variant.model === trimmed))
      continue;
    candidates.push({ model: trimmed, source: "identification_clue" });
  }

  if (candidates.length === 0) return [];

  const seen = new Set<string>();
  const deduplicated: ModelVariant[] = [];
  for (const variant of candidates) {
    const key = normalize(variant.model);
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(variant);
    }
  }

  return deduplicated.slice(0, maxModelVariants);
}
