import { Injectable } from '@nestjs/common';
import { MatchResult } from '@fittkereso-backend/database';
import { distance as levenshtein } from 'fastest-levenshtein';
import { MatchingConfigService } from './matching-config.service';
import { isEmpty, sortBy } from 'lodash';
import {
  InputNormalizationService,
  CategoryMatchConfig,
  ParsedModelCode,
} from './input-normalization.service';
import type { ResolutionOptions } from '../models/resolution-options';

export interface QualityGateResult {
  passed: boolean;
  failedGates: string[];
}

/**
 * Quality gates the matcher applies to the best candidate before accepting it.
 *
 * `evaluate` is the standard ladder. `evaluateAnchored` is the reference-product
 * variant — stricter score floor and wider ambiguity gap, since picking a
 * sibling SKU is harder than first-time identification.
 *
 * Scores are on the unified 0–100 integer scale.
 */
@Injectable()
export class QualityGatesService {
  constructor(
    private readonly matchingConfig: MatchingConfigService,
    private readonly inputNormalization: InputNormalizationService,
  ) {}

  evaluate(
    best: MatchResult,
    second: MatchResult | undefined,
    inputParsed: ParsedModelCode,
    options: ResolutionOptions,
    config: CategoryMatchConfig,
  ): QualityGateResult {
    // 1. Exact alias match → accept immediately (unless strict mode with spec mismatch)
    if (best.components.stringSimilarity === 1.0) {
      const hasSpecMismatch =
        best.specMatchDetails && best.specMatchDetails.primaryMismatches > 0;
      if (!hasSpecMismatch || options.mode !== 'strict') {
        return { passed: true, failedGates: [] };
      }
    }

    // 2. Score threshold (mode-dependent)
    const threshold =
      options.mode === 'strict'
        ? this.matchingConfig.config.acceptThresholdStrict
        : this.matchingConfig.config.acceptThreshold;

    if (best.score < threshold) {
      return { passed: false, failedGates: ['low_confidence'] };
    }

    // 3. Strict mode: reject any primary spec mismatch
    if (
      options.mode === 'strict' &&
      best.specMatchDetails &&
      best.specMatchDetails.primaryMismatches > 0
    ) {
      return { passed: false, failedGates: ['primary_spec_mismatch'] };
    }

    // 3b. Strict mode: reject when matcher spec mismatches exceed category threshold
    const maxMatcherMismatches = config.maxMatcherSpecMismatches ?? 2;
    if (
      options.mode === 'strict' &&
      best.specMatchDetails &&
      best.specMatchDetails.matcherSpecMismatches > maxMatcherMismatches
    ) {
      return { passed: false, failedGates: ['matcher_spec_mismatch'] };
    }

    // 4. Ambiguity check with tiebreakers.
    // When spec and name evidence disagree (best wins on string but loses on
    // spec) AND the gap is tight, treat as ambiguous — the spec signal suggests
    // the second candidate may be the correct one.
    if (second) {
      const gap = best.score - second.score;
      if (gap < this.matchingConfig.config.ambiguityGap) {
        const bestWinsSpec =
          best.components.specSimilarity > second.components.specSimilarity;
        const bestWinsString =
          best.components.stringSimilarity > second.components.stringSimilarity;
        const specNameConflict = bestWinsString && !bestWinsSpec;
        const isAmbiguous = specNameConflict
          ? gap < 2
          : !bestWinsSpec && !bestWinsString;
        if (isAmbiguous) {
          return { passed: false, failedGates: ['ambiguous_match'] };
        }
      }
    }

    // 5. Critical numeric gate with spec override
    const candidateParsed = this.inputNormalization.parseModelCode(
      this.inputNormalization.basicNormalization(best.alias),
      config,
    );

    if (!isEmpty(inputParsed.criticalNumericTokens)) {
      const criticalNumericHitRatio = this.calculateCriticalNumericHitRatio(
        inputParsed,
        candidateParsed,
      );

      if (criticalNumericHitRatio < 1.0) {
        const specConfirmed = this.hasSpecConfirmation(best, second);

        if (!specConfirmed) {
          return { passed: false, failedGates: ['critical_numeric_mismatch'] };
        }
      }
    }

    // 6. Suffix alpha gate (strict mode only)
    // In strict mode, suffix alpha mismatches are definitive — do NOT allow
    // spec confirmation to override, since product families can share identical
    // specs while suffix tokens are explicit product differentiators.
    if (options.mode === 'strict' && !isEmpty(inputParsed.suffixAlphaTokens)) {
      const candidateSuffixSet = new Set(candidateParsed.suffixAlphaTokens);
      const allSuffixAlphasMatch = inputParsed.suffixAlphaTokens.every(
        (token) => candidateSuffixSet.has(token),
      );

      if (!allSuffixAlphasMatch) {
        return { passed: false, failedGates: ['suffix_alpha_mismatch'] };
      }
    }

    return { passed: true, failedGates: [] };
  }

  /**
   * Multi-candidate filter for the new decision pipeline.
   *
   * Returns every candidate that satisfies BOTH:
   *   (a) score ≥ acceptThreshold(mode) — mode-aware floor.
   *   (b) score ≥ topScore − ambiguityGap — within the gap of the top score.
   *
   * The two conditions combine: effective floor = max(acceptThreshold, topScore − gap).
   * Strict-mode side conditions (primary spec mismatch, matcher spec mismatches,
   * critical numeric mismatch, suffix-alpha mismatch) are applied PER-CANDIDATE —
   * a candidate that trips a side condition is dropped from the result set, not
   * the whole set.
   *
   * Returns survivors sorted descending by score so callers can take [0] as
   * the primary.
   */
  filterAcceptable(
    candidates: ReadonlyArray<MatchResult>,
    inputParsed: ParsedModelCode,
    options: ResolutionOptions,
    config: CategoryMatchConfig,
  ): MatchResult[] {
    if (candidates.length === 0) return [];

    const cfg = this.matchingConfig.config;
    const threshold =
      options.mode === 'strict'
        ? cfg.acceptThresholdStrict
        : cfg.acceptThreshold;
    const ambiguityGap = cfg.ambiguityGap;

    const sorted = sortBy(candidates, (c) => -c.score);
    const topScore = sorted[0].score;
    const effectiveFloor = Math.max(threshold, topScore - ambiguityGap);
    const maxMatcherMismatches = config.maxMatcherSpecMismatches ?? 2;
    const candidateSuffixCache = new Map<string, ParsedModelCode>();

    return sorted.filter((candidate) => {
      // Exact alias match → keep unless strict mode + spec mismatch (matches
      // `evaluate` rule 1's behavior, applied per-candidate).
      if (candidate.components.stringSimilarity === 1.0) {
        const hasSpecMismatch =
          candidate.specMatchDetails &&
          candidate.specMatchDetails.primaryMismatches > 0;
        if (!hasSpecMismatch || options.mode !== 'strict') {
          return true;
        }
        return false;
      }

      // (a) + (b): combined floor.
      if (candidate.score < effectiveFloor) return false;

      // Strict-mode per-candidate side conditions.
      if (options.mode === 'strict') {
        if (
          candidate.specMatchDetails &&
          candidate.specMatchDetails.primaryMismatches > 0
        ) {
          return false;
        }
        if (
          candidate.specMatchDetails &&
          candidate.specMatchDetails.matcherSpecMismatches >
            maxMatcherMismatches
        ) {
          return false;
        }
      }

      // Critical numeric gate — applies in both modes, with spec confirmation
      // override (matches `evaluate` rule 5).
      if (!isEmpty(inputParsed.criticalNumericTokens)) {
        const candidateParsed = this.parseCandidate(
          candidate.alias,
          config,
          candidateSuffixCache,
        );
        const hitRatio = this.calculateCriticalNumericHitRatio(
          inputParsed,
          candidateParsed,
        );
        if (hitRatio < 1.0 && !this.hasSpecConfirmation(candidate, undefined)) {
          return false;
        }
      }

      // Strict-mode suffix-alpha gate (matches `evaluate` rule 6).
      if (
        options.mode === 'strict' &&
        !isEmpty(inputParsed.suffixAlphaTokens)
      ) {
        const candidateParsed = this.parseCandidate(
          candidate.alias,
          config,
          candidateSuffixCache,
        );
        const candidateSuffixSet = new Set(candidateParsed.suffixAlphaTokens);
        const allSuffixAlphasMatch = inputParsed.suffixAlphaTokens.every(
          (token) => candidateSuffixSet.has(token),
        );
        if (!allSuffixAlphasMatch) return false;
      }

      return true;
    });
  }

  /** Parse + cache a candidate's alias once per filterAcceptable call, since
   *  parseModelCode is non-trivial and may be hit twice (critical-numeric +
   *  suffix-alpha) for the same candidate. */
  private parseCandidate(
    alias: string,
    config: CategoryMatchConfig,
    cache: Map<string, ParsedModelCode>,
  ): ParsedModelCode {
    const cached = cache.get(alias);
    if (cached) return cached;
    const parsed = this.inputNormalization.parseModelCode(
      this.inputNormalization.basicNormalization(alias),
      config,
    );
    cache.set(alias, parsed);
    return parsed;
  }

  /**
   * Quality gate variant for reference-product variant resolution.
   *
   * Applies a stricter score floor and wider ambiguity gap to reduce false
   * positives when picking a sibling SKU. The reference product itself is
   * filtered out at recall time, so the "reference self-match" gate is gone —
   * by construction the matcher never sees the reference as a candidate.
   */
  evaluateAnchored(
    best: MatchResult,
    second: MatchResult | undefined,
    inputParsed: ParsedModelCode,
    options: ResolutionOptions,
    config: CategoryMatchConfig,
  ): QualityGateResult {
    // Score floor uses the unified `acceptThreshold`. Anchored mode's extra
    // strictness comes from `ambiguityGapAnchored` below, not a different
    // absolute floor. The `low_confidence_anchored` gate name is preserved so
    // traces still distinguish anchored-mode rejections from regular ones.
    if (best.score < this.matchingConfig.config.acceptThreshold) {
      return { passed: false, failedGates: ['low_confidence_anchored'] };
    }

    // Wider ambiguity gap for reference-product variant resolution
    if (second) {
      const gap = best.score - second.score;
      if (gap < this.matchingConfig.config.ambiguityGapAnchored) {
        return { passed: false, failedGates: ['ambiguous_match_anchored'] };
      }
    }

    // Apply remaining standard gates (critical numeric, suffix alpha, spec mismatches)
    const standardResult = this.evaluate(
      best,
      second,
      inputParsed,
      options,
      config,
    );
    if (!standardResult.passed) {
      return standardResult;
    }

    return { passed: true, failedGates: [] };
  }

  /**
   * Spec confirmation: best has comparable primary specs with no mismatches,
   * and either there is no second candidate or the second has mismatches.
   */
  private hasSpecConfirmation(
    best: MatchResult,
    second: MatchResult | undefined,
  ): boolean {
    const bestSpecs = best.specMatchDetails;
    if (!bestSpecs || bestSpecs.comparableCount === 0) return false;
    if (bestSpecs.primaryMismatches > 0) return false;
    if (bestSpecs.matcherSpecMismatches > 0) return false;

    if (second == null) return true;

    const secondSpecs = second.specMatchDetails;
    if (!secondSpecs || secondSpecs.comparableCount === 0) return true;
    return (
      secondSpecs.primaryMismatches > 0 ||
      secondSpecs.matcherSpecMismatches > 0 ||
      bestSpecs.matchingCount > secondSpecs.matchingCount
    );
  }

  private calculateCriticalNumericHitRatio(
    input: ParsedModelCode,
    candidate: ParsedModelCode,
  ): number {
    if (isEmpty(input.criticalNumericTokens)) return 1;

    let hits = 0;
    for (const criticalToken of input.criticalNumericTokens) {
      const candidateNums = candidate.words.filter((word) => /\d/.test(word));
      if (isEmpty(candidateNums)) continue;

      const bestDistance = Math.min(
        ...candidateNums.map((candidateWord) =>
          levenshtein(criticalToken, candidateWord),
        ),
      );
      if (bestDistance === 0) hits++;
    }

    return hits / input.criticalNumericTokens.length;
  }
}
