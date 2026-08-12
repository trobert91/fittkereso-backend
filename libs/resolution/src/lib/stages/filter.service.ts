import { Injectable } from '@nestjs/common';
import { SpecComparisonService } from '@fittkereso-backend/product';
import type {
  ProductSpecs,
  StructuredSpec,
} from '@fittkereso-backend/database';
import { isEmpty, isNil } from 'lodash';
import {
  InputNormalizationService,
  type CategoryMatchConfig,
} from '../matching/input-normalization.service';
import { computeEffectiveMatchSpecs } from '../matching/effective-match-specs';
import type {
  ResolutionContext,
  FilterOutcome,
} from '../models/resolution-context';
import type { SlimCandidate } from '../models/slim-types';

export interface FilterResult {
  qualifyingCandidates: SlimCandidate[];
  outcome: FilterOutcome;
}

/**
 * Drop candidates that violate `effectiveMatchSpecs` or the category constraint.
 *
 * Spec rejection: candidate's value on any primary-spec key in
 * `effectiveMatchSpecs` must match (using `SpecComparisonService` semantics, so
 * matcher-spec-hierarchies-compatible values still pass). Candidates with no
 * specs at all pass — we cannot contradict what isn't there.
 *
 * Category rejection: when `ctx.category` is set, the candidate's
 * `productCategory.name` must match (case-insensitive). When unset, the gate is
 * skipped.
 *
 * Falls back to `inputSpecs ∩ primarySpecs` when `effectiveMatchSpecs` is empty
 * (the unanchored path).
 */
@Injectable()
export class FilterService {
  constructor(
    private readonly specComparison: SpecComparisonService,
    private readonly inputNormalization: InputNormalizationService,
  ) {}

  filter(context: ResolutionContext): FilterResult {
    const candidates = context.candidates;
    const effectiveMatchSpecs = context.effectiveMatchSpecs;
    const inputSpecs = context.input.specs;
    const effectiveCategory = context.category;
    const effectiveBrand = context.brand;

    const qualifyingCandidates: SlimCandidate[] = [];
    const filteredCandidates: FilterOutcome['filteredCandidates'] = [];

    for (const candidate of candidates) {
      const brandRejection = this.checkBrand(candidate, effectiveBrand);
      if (brandRejection) {
        filteredCandidates.push(brandRejection);
        continue;
      }

      const categoryRejection = this.checkCategory(
        candidate,
        effectiveCategory,
      );
      if (categoryRejection) {
        filteredCandidates.push(categoryRejection);
        continue;
      }

      // One config lookup per candidate, shared by both spec checks below
      // (getCategoryConfig itself caches by category id across candidates).
      const matchConfig = this.inputNormalization.getCategoryConfig(
        candidate.productCategory,
      );
      const matchSpecs = this.resolveMatchSpecs(
        effectiveMatchSpecs,
        inputSpecs,
        matchConfig,
      );
      const specRejection = this.checkSpecs(candidate, matchSpecs, matchConfig);
      if (specRejection) {
        filteredCandidates.push(specRejection);
        continue;
      }

      qualifyingCandidates.push(candidate);
    }

    return {
      qualifyingCandidates,
      outcome: {
        qualifyingCandidateIds: qualifyingCandidates.map(
          (candidate) => candidate.productId,
        ),
        filteredCandidates,
      },
    };
  }

  private resolveMatchSpecs(
    effectiveMatchSpecs: ProductSpecs | undefined,
    inputSpecs: StructuredSpec[] | undefined,
    matchConfig: CategoryMatchConfig,
  ): ProductSpecs {
    if (effectiveMatchSpecs && Object.keys(effectiveMatchSpecs).length > 0) {
      return effectiveMatchSpecs;
    }
    if (!inputSpecs || inputSpecs.length === 0) {
      return {};
    }
    return computeEffectiveMatchSpecs(
      undefined,
      inputSpecs,
      matchConfig.primarySpecs,
    );
  }

  private checkSpecs(
    candidate: SlimCandidate,
    matchSpecs: ProductSpecs,
    matchConfig: CategoryMatchConfig,
  ): FilterOutcome['filteredCandidates'][number] | undefined {
    if (isEmpty(matchSpecs)) return undefined;

    const primarySpecs = Object.keys(matchSpecs);
    const missingKey = primarySpecs.find((key) =>
      isNil(candidate.specs?.[key]),
    );
    if (missingKey) {
      return {
        candidateId: candidate.productId,
        candidateName: candidateLabel(candidate),
        reason: 'match_specs',
        detail: `${missingKey} (unset) ≠ ${formatSpecValue(matchSpecs[missingKey])}`,
      };
    }

    const result = this.specComparison.compareSpecs({
      specsA: matchSpecs,
      specsB: candidate.specs,
      primarySpecs,
      matcherSpecHierarchies: matchConfig.matcherSpecHierarchies,
    });

    if (result.primaryMismatches === 0) return undefined;

    const detail = this.formatSpecMismatchDetail(
      matchSpecs,
      candidate.specs ?? {},
      result,
    );
    return {
      candidateId: candidate.productId,
      candidateName: candidateLabel(candidate),
      reason: 'match_specs',
      detail,
    };
  }

  /**
   * Brand gate. Mirrors `checkCategory`: id-equality preferred when both sides
   * carry an id; case-insensitive name fallback when one side lacks an id.
   * Skipped entirely when the resolved input brand is unset.
   *
   * Runs before the category gate because brand is the stricter signal — a
   * branded input shouldn't match a different-brand candidate even when the
   * category aligns. Catches wrong-brand candidates that slip past recall
   * (notably the embedding nearest-neighbor path, which can return adjacent
   * SKUs from other brands).
   */
  private checkBrand(
    candidate: SlimCandidate,
    effectiveBrand: { id: string; name: string } | undefined,
  ): FilterOutcome['filteredCandidates'][number] | undefined {
    if (!effectiveBrand) return undefined;

    const candidateBrandId = candidate.brandId;
    const candidateBrandName = candidate.brand;

    // Authoritative path: id equality.
    if (effectiveBrand.id && candidateBrandId) {
      if (effectiveBrand.id === candidateBrandId) return undefined;
      return {
        candidateId: candidate.productId,
        candidateName: candidateLabel(candidate),
        reason: 'brand',
        detail: `brand '${candidateBrandName ?? candidateBrandId}' (${candidateBrandId}) ≠ '${effectiveBrand.name}' (${effectiveBrand.id})`,
      };
    }

    // Fallback: case-insensitive name equality, when one side lacks an id.
    if (
      candidateBrandName &&
      candidateBrandName.toLowerCase() === effectiveBrand.name.toLowerCase()
    ) {
      return undefined;
    }
    return {
      candidateId: candidate.productId,
      candidateName: candidateLabel(candidate),
      reason: 'brand',
      detail: `brand '${candidateBrandName ?? '(unset)'}' ≠ '${effectiveBrand.name}'`,
    };
  }

  /**
   * Category gate. Prefers id-based equality when both sides have a category
   * id (the common case after `CategoryResolver` runs — the input category was
   * pre-resolved at extraction time and every catalog candidate carries its
   * row id). Falls back to a case-insensitive name comparison only when one
   * side lacks an id, so this still works for v2 inputs the caller didn't
   * pre-resolve.
   *
   * Comparing by name alone breaks on plural/singular casing differences in
   * the catalog vs. the LLM (e.g. "Monitors" catalog row vs. "monitor"
   * categoryHint).
   */
  private checkCategory(
    candidate: SlimCandidate,
    effectiveCategory: { id: string; name: string } | undefined,
  ): FilterOutcome['filteredCandidates'][number] | undefined {
    if (!effectiveCategory) return undefined;
    const candidateCategory = candidate.productCategory;
    if (!candidateCategory) return undefined;

    // Authoritative path: id equality.
    if (effectiveCategory.id && candidateCategory.id) {
      if (effectiveCategory.id === candidateCategory.id) return undefined;
      return {
        candidateId: candidate.productId,
        candidateName: candidateLabel(candidate),
        reason: 'category',
        detail: `category '${candidateCategory.name}' (${candidateCategory.id}) ≠ '${effectiveCategory.name}' (${effectiveCategory.id})`,
      };
    }

    // Fallback: case-insensitive name equality, when one side lacks an id.
    if (
      candidateCategory.name.toLowerCase() ===
      effectiveCategory.name.toLowerCase()
    ) {
      return undefined;
    }
    return {
      candidateId: candidate.productId,
      candidateName: candidateLabel(candidate),
      reason: 'category',
      detail: `category '${candidateCategory.name}' ≠ '${effectiveCategory.name}'`,
    };
  }

  private formatSpecMismatchDetail(
    matchSpecs: ProductSpecs,
    candidateSpecs: ProductSpecs,
    result: {
      details: Array<{
        key: string;
        valueA: unknown;
        valueB: unknown;
        match: string;
        isPrimary: boolean;
      }>;
    },
  ): string {
    const firstMismatch = result.details.find(
      (entry) =>
        entry.isPrimary &&
        entry.match !== 'match' &&
        entry.match !== 'compatible',
    );
    if (firstMismatch) {
      const expected = formatSpecValue(matchSpecs[firstMismatch.key]);
      const actual = formatSpecValue(candidateSpecs[firstMismatch.key]);
      return `${firstMismatch.key} ${actual} ≠ ${expected}`;
    }
    return 'primary spec mismatch';
  }
}

function formatSpecValue(value: unknown): string {
  if (isNil(value)) return '(unset)';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * Human-readable label for a slim candidate. Prefers `displayName`, falls back
 * to `brand model`, then `model` alone. Used to enrich filter-stage rejection
 * entries so trace readers don't have to cross-reference candidateId against
 * `ctx.candidates`.
 */
function candidateLabel(candidate: SlimCandidate): string | undefined {
  if (candidate.displayName) return candidate.displayName;
  const brand = candidate.brand?.trim();
  const model = candidate.model?.trim();
  if (brand && model) return `${brand} ${model}`;
  return model || brand || undefined;
}
