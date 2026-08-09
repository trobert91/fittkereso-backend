import { Injectable } from "@nestjs/common";
import { ProductSpecs, SpecMatchDetails } from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { CustomLogger } from "@ebike-backend/logger";
import { distance as levenshtein } from "fastest-levenshtein";
import { isEmpty } from "lodash";
import { SpecComparisonService } from "../duplicate/spec-comparison.service";
import {
  SimilarityInputNormalizationService,
  ParsedName,
} from "./similarity-input-normalization.service";
import {
  ParsedTokens,
  TokenParserConfig,
  basicNormalization,
  getTokenWeights,
} from "./token-parser";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface SimilarityTraceContext {
  threadId?: string;
  commentId?: string;
  productReferenceId?: string;
  productId?: string;
}

export interface ProductSimilarityInput {
  query: {
    model: string;
    displayName?: string;
    aliases?: string[];
    specs?: ProductSpecs;
    year?: number;
  };
  candidate: {
    model: string;
    displayName?: string;
    aliases?: string[];
    specs?: ProductSpecs;
    releaseYear?: number;
  };
  brandName?: string;
  categorySlug?: string;
  /** Optional trace context for recording debug traces queryable via MCP. */
  traceContext?: SimilarityTraceContext;
}

export interface SimilarityComponents {
  stringSimilarity: number;
  tokenOverlap: number;
  alphaMatch: number;
  aliasMatch: boolean;
  /** Spec similarity score for tiebreaking only — not used in the score formula. */
  specSimilarity: number;
}

export interface ProductSimilarityResult {
  score: number;
  components: SimilarityComponents;
  specMatchDetails?: SpecMatchDetails;
  bestMatchName: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const NAME_WEIGHTS = {
  stringSimilarity: 0.7,
  tokenOverlap: 0.2,
  alphaMatch: 0.1,
};

/** Penalty when input has critical-numeric tokens that don't all appear in the
 *  candidate. Catches typos (e.g. 431CQPX vs 341CQPX) and wrong-model-number
 *  cases that stringSim alone may not collapse far enough on. */
const CRITICAL_NUMERIC_PENALTY = 15;

/** Penalty when suffix-alpha tokens disagree as product-line discriminators
 *  (e.g. PG34WCDM vs PG34WCDN, S2722DGM vs S2722QGM). Variant-appendage
 *  differences (B vs X, T vs TWP) are NOT penalized — those are color/region
 *  variants of the same product. The variant-vs-discriminator distinction is
 *  delegated to `isSuffixOnlyMismatch`. */
const SUFFIX_DISCRIMINATOR_PENALTY = 15;

const PRIMARY_SPEC_MISMATCH_PENALTY = 20;
const MATCHER_SPEC_MISMATCH_PENALTY = 10;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ProductSimilarityService {
  private readonly logger = new CustomLogger(ProductSimilarityService.name);

  constructor(
    private readonly inputNormalization: SimilarityInputNormalizationService,
    private readonly specComparison: SpecComparisonService,
    private readonly debugTrace: DebugTraceService,
  ) {}

  score(input: ProductSimilarityInput): ProductSimilarityResult {
    const startMs = Date.now();
    const emptyComponents: SimilarityComponents = {
      stringSimilarity: 0,
      tokenOverlap: 0,
      alphaMatch: 0,
      aliasMatch: false,
      specSimilarity: 0,
    };

    // Year gate: candidate released after query year → impossible match
    if (
      input.query.year !== undefined &&
      input.candidate.releaseYear !== undefined &&
      input.candidate.releaseYear > input.query.year
    ) {
      this.logger.debug("Year gate: candidate released after query year", {
        queryModel: input.query.model,
        candidateModel: input.candidate.model,
        queryYear: input.query.year,
        candidateReleaseYear: input.candidate.releaseYear,
      });
      return { score: 0, components: emptyComponents, bestMatchName: "" };
    }

    // Build normalized name lists
    const nameLists = this.inputNormalization.buildNameLists({
      query: input.query,
      candidate: input.candidate,
      brandName: input.brandName,
      categorySlug: input.categorySlug,
    });

    if (isEmpty(nameLists.queryNames) || isEmpty(nameLists.candidateNames)) {
      return { score: 0, components: emptyComponents, bestMatchName: "" };
    }

    // Cross-match all query names × candidate names, keep best pair
    const bestPair = this.findBestNamePair(
      nameLists.queryNames,
      nameLists.candidateNames,
      nameLists.tokenConfig,
    );

    // Structured spec comparison for primary mismatch detection and diagnostics
    const hierarchies = this.inputNormalization.getMatcherSpecHierarchies(
      input.categorySlug,
    );
    const primarySpecs = this.inputNormalization.getPrimarySpecs(
      input.categorySlug,
    );
    const matcherSpecs = this.inputNormalization.getMatcherSpecs(
      input.categorySlug,
    );
    const specMatchDetails = this.computeSpecMatchDetails(
      input.query.specs,
      input.candidate.specs,
      primarySpecs,
      hierarchies,
      matcherSpecs,
    );

    // Spec similarity for tiebreaking (not used in score formula)
    const specSimilarity = this.specComparison.computeSpecSimilarityScore(
      input.query.specs,
      input.candidate.specs,
      hierarchies,
      primarySpecs,
      matcherSpecs,
    );

    // Alias match (diagnostic)
    const aliasMatch = this.checkAliasMatch(
      nameLists.queryNames,
      nameLists.candidateNames,
    );

    // Name base: weighted combination of name components, scaled to 0..100.
    const nameBase = Math.round(
      (bestPair.stringSimilarity * NAME_WEIGHTS.stringSimilarity +
        bestPair.tokenOverlap * NAME_WEIGHTS.tokenOverlap +
        bestPair.alphaMatch * NAME_WEIGHTS.alphaMatch) *
        100,
    );

    // Critical-numeric disagreement: input has critical numerics not all in candidate.
    const candidateNumerics = bestPair.candidateParsed.words.filter((word) =>
      /\d/.test(word),
    );
    const hasCriticalNumericDisagreement =
      !isEmpty(bestPair.queryParsed.criticalNumericTokens) &&
      !bestPair.queryParsed.criticalNumericTokens.every((token) =>
        candidateNumerics.includes(token),
      );
    const criticalNumericPenalty = hasCriticalNumericDisagreement
      ? CRITICAL_NUMERIC_PENALTY
      : 0;

    // Suffix-alpha discriminator: suffix tokens differ AND the difference is NOT
    // just a variant appendage (color/region code). Reuses isSuffixOnlyMismatch
    // which encodes the variant-vs-discriminator distinction.
    const suffixMismatchPresent =
      bestPair.queryParsed.suffixAlphaTokens.length !==
        bestPair.candidateParsed.suffixAlphaTokens.length ||
      !bestPair.queryParsed.suffixAlphaTokens.every((token) =>
        bestPair.candidateParsed.suffixAlphaTokens.includes(token),
      );
    const hasSuffixDiscriminatorMismatch =
      suffixMismatchPresent &&
      !this.isSuffixOnlyMismatch(
        bestPair.queryParsed,
        bestPair.candidateParsed,
        bestPair.stringSimilarity,
      );
    const suffixDiscriminatorPenalty = hasSuffixDiscriminatorMismatch
      ? SUFFIX_DISCRIMINATOR_PENALTY
      : 0;

    // Spec mismatch penalties — specs only deduct, never reward. Missing spec
    // on candidate is already counted as a matcher mismatch by compareSpecs.
    const primaryMismatches = specMatchDetails?.primaryMismatches ?? 0;
    const matcherMismatches = specMatchDetails?.matcherSpecMismatches ?? 0;
    const specPenalty =
      primaryMismatches * PRIMARY_SPEC_MISMATCH_PENALTY +
      matcherMismatches * MATCHER_SPEC_MISMATCH_PENALTY;

    const score = Math.max(
      0,
      Math.min(
        100,
        nameBase -
          criticalNumericPenalty -
          suffixDiscriminatorPenalty -
          specPenalty,
      ),
    );

    const result: ProductSimilarityResult = {
      score,
      components: {
        stringSimilarity: bestPair.stringSimilarity,
        tokenOverlap: bestPair.tokenOverlap,
        alphaMatch: bestPair.alphaMatch,
        aliasMatch,
        specSimilarity,
      },
      specMatchDetails,
      bestMatchName: bestPair.candidateName,
    };

    if (input.traceContext) {
      this.recordTrace(
        input,
        result,
        {
          nameBase,
          criticalNumericPenalty,
          suffixDiscriminatorPenalty,
          specPenalty,
        },
        startMs,
      );
    }

    return result;
  }

  // ─── Trace Recording ────────────────────────────────────────────────────────

  private recordTrace(
    input: ProductSimilarityInput,
    result: ProductSimilarityResult,
    breakdown: {
      nameBase: number;
      criticalNumericPenalty: number;
      suffixDiscriminatorPenalty: number;
      specPenalty: number;
    },
    startMs: number,
  ): void {
    const context = input.traceContext!;
    const scoreLabel =
      result.score >= 80 ? "high" : result.score >= 50 ? "medium" : "low";

    this.debugTrace
      .record({
        threadId: context.threadId,
        commentId: context.commentId,
        productReferenceId: context.productReferenceId,
        productId: context.productId,
        step: "product_similarity",
        statusBefore: "scoring",
        statusAfter: `scored_${scoreLabel}`,
        durationMs: Date.now() - startMs,
        data: {
          summary: `${input.query.model} → ${input.candidate.model}: score=${result.score} (nameBase=${breakdown.nameBase}, critNumPen=${breakdown.criticalNumericPenalty}, suffixPen=${breakdown.suffixDiscriminatorPenalty}, specPen=${breakdown.specPenalty}, alias=${result.components.aliasMatch})`,
          similarity: {
            query: {
              model: input.query.model,
              displayName: input.query.displayName,
              aliasCount: input.query.aliases?.length ?? 0,
              hasSpecs: !isEmpty(input.query.specs),
              year: input.query.year,
            },
            candidate: {
              model: input.candidate.model,
              displayName: input.candidate.displayName,
              aliasCount: input.candidate.aliases?.length ?? 0,
              hasSpecs: !isEmpty(input.candidate.specs),
              releaseYear: input.candidate.releaseYear,
            },
            brandName: input.brandName,
            categorySlug: input.categorySlug,
            result: {
              score: result.score,
              nameBase: breakdown.nameBase,
              criticalNumericPenalty: breakdown.criticalNumericPenalty,
              suffixDiscriminatorPenalty: breakdown.suffixDiscriminatorPenalty,
              specPenalty: breakdown.specPenalty,
              bestMatchName: result.bestMatchName,
              components: result.components,
              specMatchDetails: result.specMatchDetails,
            },
          },
        },
      })
      .catch((error: unknown) => {
        this.logger.warn("Failed to record similarity trace", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // ─── Name Pair Matching ────────────────────────────────────────────────────

  private findBestNamePair(
    queryNames: ParsedName[],
    candidateNames: ParsedName[],
    tokenConfig: TokenParserConfig,
  ): {
    stringSimilarity: number;
    tokenOverlap: number;
    alphaMatch: number;
    queryParsed: ParsedTokens;
    candidateParsed: ParsedTokens;
    candidateName: string;
  } {
    let bestScore = -Infinity;
    let bestResult = {
      stringSimilarity: 0,
      tokenOverlap: 0,
      alphaMatch: 0,
      queryParsed: queryNames[0].parsed,
      candidateParsed: candidateNames[0].parsed,
      candidateName: candidateNames[0].normalized,
    };

    for (const queryName of queryNames) {
      for (const candidateName of candidateNames) {
        const tokenDistance = this.calculateTokenDistance(
          queryName.parsed,
          candidateName.parsed,
          tokenConfig,
        );
        const maxDistance = this.computeMaxDistance(
          queryName.parsed,
          candidateName.parsed,
        );
        const stringSimilarity = Math.max(
          0,
          Math.min(1, 1 - tokenDistance / Math.max(maxDistance, 1)),
        );
        const tokenOverlap = this.calculateTokenOverlap(
          queryName.parsed,
          candidateName.parsed,
        );
        const alphaMatch = this.calculateAlphaMatch(
          queryName.parsed,
          candidateName.parsed,
        );

        const pairScore =
          stringSimilarity * NAME_WEIGHTS.stringSimilarity +
          tokenOverlap * NAME_WEIGHTS.tokenOverlap +
          alphaMatch * NAME_WEIGHTS.alphaMatch;

        if (pairScore > bestScore) {
          bestScore = pairScore;
          bestResult = {
            stringSimilarity,
            tokenOverlap,
            alphaMatch,
            queryParsed: queryName.parsed,
            candidateParsed: candidateName.parsed,
            candidateName: candidateName.normalized,
          };
        }
      }
    }

    return bestResult;
  }

  // ─── Token Distance ────────────────────────────────────────────────────────

  private calculateTokenDistance(
    input: ParsedTokens,
    candidate: ParsedTokens,
    config: TokenParserConfig,
  ): number {
    let distance = 0;
    const inputWeights = getTokenWeights(input.words, config);

    // Build all pairwise distances and sort ascending so the best matches are
    // assigned first. This prevents a poor-fitting input token (e.g. "oled")
    // from stealing a candidate slot that a high-quality token (e.g. "pg32ucdm")
    // needs.
    const pairs: Array<{
      inputIdx: number;
      candidateIdx: number;
      dist: number;
    }> = [];
    for (let i = 0; i < input.words.length; i++) {
      for (let j = 0; j < candidate.words.length; j++) {
        pairs.push({
          inputIdx: i,
          candidateIdx: j,
          dist: levenshtein(input.words[i], candidate.words[j]),
        });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const usedInput = new Set<number>();
    const usedCandidate = new Set<number>();

    const inputNumericTokens = input.words.filter((word) => /\d/.test(word));
    let numericPerfectMatches = 0;

    for (const pair of pairs) {
      if (usedInput.has(pair.inputIdx) || usedCandidate.has(pair.candidateIdx))
        continue;

      usedInput.add(pair.inputIdx);
      usedCandidate.add(pair.candidateIdx);

      const inputWord = input.words[pair.inputIdx];
      const candidateWord = candidate.words[pair.candidateIdx];
      const isNumeric = /\d/.test(inputWord);
      let best = pair.dist;

      if (isNumeric && best === 0) {
        numericPerfectMatches++;
      }

      if (best > 0) {
        const bothNumeric =
          /^\d+$/.test(inputWord) && /^\d+$/.test(candidateWord);
        const isNumericPrefix =
          bothNumeric &&
          (inputWord.startsWith(candidateWord) ||
            candidateWord.startsWith(inputWord));

        if (
          !isNumericPrefix &&
          (inputWord.startsWith(candidateWord) ||
            candidateWord.startsWith(inputWord))
        ) {
          const lenRatio =
            Math.max(inputWord.length, candidateWord.length) /
            Math.min(inputWord.length, candidateWord.length);
          best *= lenRatio;
        }
      }

      const categoryWeight = inputWeights[pair.inputIdx];
      const baseWeight = isNumeric ? 2 : 1;
      const finalWeight = baseWeight + Math.max(0, categoryWeight - 1.0);

      distance += best * finalWeight;
    }

    const allNumericsPerfect =
      inputNumericTokens.length > 0 &&
      numericPerfectMatches === inputNumericTokens.length;

    // Amplify alpha differences when all numerics match perfectly — "same numbers but
    // different letters" is suspicious. But skip the amplifier when all critical alpha
    // tokens also match (the mismatch is suffix-only, handled by the suffix bonus).
    if (allNumericsPerfect && distance > 0) {
      const candidateAlphaWords = candidate.words.filter((word) =>
        /^[a-z]+$/.test(word),
      );
      const allCriticalAlphaMatch =
        input.criticalAlphaTokens.length === 0 ||
        input.criticalAlphaTokens.every((token) =>
          candidateAlphaWords.includes(token),
        );

      if (!allCriticalAlphaMatch) {
        distance *= 2.5;
      }
    }

    // Unmatched candidate words: the candidate has something the query doesn't mention.
    for (let j = 0; j < candidate.words.length; j++) {
      if (usedCandidate.has(j)) continue;
      if (/\d/.test(candidate.words[j])) {
        distance += 1.5;
      } else {
        distance += allNumericsPerfect ? 1.0 : 0.5;
      }
    }

    // Unmatched input words: the query has extra context the candidate doesn't mention.
    // Apply the same symmetric penalties so extra noise words (e.g. "oled", "4k") cost
    // the same as missing candidate words of the same type.
    for (let i = 0; i < input.words.length; i++) {
      if (usedInput.has(i)) continue;
      if (/\d/.test(input.words[i])) {
        distance += 1.5;
      } else {
        distance += allNumericsPerfect ? 1.0 : 0.5;
      }
    }

    return distance;
  }

  private computeMaxDistance(
    input: ParsedTokens,
    candidate: ParsedTokens,
  ): number {
    let wordAligned = 0;
    const maxLen = Math.max(input.words.length, candidate.words.length);
    for (let i = 0; i < maxLen; i++) {
      const inputLen = input.words[i]?.length ?? 0;
      const candidateLen = candidate.words[i]?.length ?? 0;
      wordAligned += Math.max(inputLen, candidateLen);
    }

    const inputChars = input.words.reduce((sum, word) => sum + word.length, 0);
    const candidateChars = candidate.words.reduce(
      (sum, word) => sum + word.length,
      0,
    );
    const charFallback = Math.max(inputChars, candidateChars);

    return Math.max(wordAligned, charFallback);
  }

  // ─── Token Overlap ─────────────────────────────────────────────────────────

  /**
   * Fraction of input tokens that have an exact match (lev=0) in the candidate.
   * Changed from lev≤1 to lev=0 to avoid correlation with stringSimilarity.
   */
  private calculateTokenOverlap(
    input: ParsedTokens,
    candidate: ParsedTokens,
  ): number {
    if (isEmpty(input.words) || isEmpty(candidate.words)) return 0;

    let hits = 0;
    for (const word of input.words) {
      const best = Math.min(
        ...candidate.words.map((candidateWord) =>
          levenshtein(word, candidateWord),
        ),
      );
      if (best === 0) hits++;
    }

    return hits / input.words.length;
  }

  // ─── Alpha Match ───────────────────────────────────────────────────────────

  /**
   * Fraction of critical alpha tokens that have an exact match in candidate alpha words.
   * When no critical alpha tokens exist, returns 0 (signal is absent — weight is redistributed).
   */
  private calculateAlphaMatch(
    input: ParsedTokens,
    candidate: ParsedTokens,
  ): number {
    if (isEmpty(input.criticalAlphaTokens)) return 0;

    const candidateAlphaWords = candidate.words.filter((word) =>
      /^[a-z]+$/.test(word),
    );

    let hits = 0;
    for (const criticalToken of input.criticalAlphaTokens) {
      if (isEmpty(candidateAlphaWords)) continue;
      const best = Math.min(
        ...candidateAlphaWords.map((candidateWord) =>
          levenshtein(criticalToken, candidateWord),
        ),
      );
      if (best === 0) hits++;
    }

    return hits / input.criticalAlphaTokens.length;
  }

  // ─── Alias Match ───────────────────────────────────────────────────────────

  /**
   * Cross-match: if any normalized query name equals any normalized candidate name.
   */
  private checkAliasMatch(
    queryNames: ParsedName[],
    candidateNames: ParsedName[],
  ): boolean {
    const candidateSet = new Set(candidateNames.map((name) => name.normalized));
    return queryNames.some((queryName) =>
      candidateSet.has(queryName.normalized),
    );
  }

  // ─── Spec Match Details ─────────────────────────────────────────────────────

  private computeSpecMatchDetails(
    querySpecs: ProductSpecs | undefined,
    candidateSpecs: ProductSpecs | undefined,
    primarySpecs: string[] | undefined,
    hierarchies?: Record<string, Record<string, string[]>>,
    matcherSpecs?: string[],
  ): SpecMatchDetails | undefined {
    if (!querySpecs || !candidateSpecs) return undefined;

    return this.specComparison.compareSpecs({
      specsA: querySpecs,
      specsB: candidateSpecs,
      primarySpecs,
      matcherSpecs,
      matcherSpecHierarchies: hierarchies,
    });
  }

  // ─── Suffix-Only Bonus ─────────────────────────────────────────────────────

  /**
   * Suffix-only mismatch: all critical numeric and critical alpha tokens match exactly,
   * and the only mismatches are in suffix alpha tokens that are variant appendages
   * (short suffixes like TWP, B) — NOT product-line discriminators (dgm, qgm).
   */
  private isSuffixOnlyMismatch(
    queryParsed: ParsedTokens,
    candidateParsed: ParsedTokens,
    stringSimilarity: number,
  ): boolean {
    if (stringSimilarity >= 1.0) return false;

    // All critical numeric tokens must match exactly
    if (!isEmpty(queryParsed.criticalNumericTokens)) {
      const candidateNums = candidateParsed.words.filter((word) =>
        /\d/.test(word),
      );
      const allCriticalNumericMatch = queryParsed.criticalNumericTokens.every(
        (token) => candidateNums.includes(token),
      );
      if (!allCriticalNumericMatch) return false;
    }

    // All critical alpha tokens must match exactly
    if (!isEmpty(queryParsed.criticalAlphaTokens)) {
      const candidateAlphaWords = candidateParsed.words.filter((word) =>
        /^[a-z]+$/.test(word),
      );
      const allCriticalAlphaMatch = queryParsed.criticalAlphaTokens.every(
        (token) => candidateAlphaWords.includes(token),
      );
      if (!allCriticalAlphaMatch) return false;
    }

    // There must be suffix alpha tokens that differ
    if (
      isEmpty(queryParsed.suffixAlphaTokens) &&
      isEmpty(candidateParsed.suffixAlphaTokens)
    ) {
      return false;
    }

    // Every mismatched suffix token pair must be a "variant appendage":
    // (a) one is a prefix of the other (e.g. "t" → "twwp"), OR
    // (b) the shorter token has length ≤ 2 (e.g. "b" vs "x")
    // This excludes standalone discriminators like "dgm" vs "qgm".
    return this.areSuffixesVariantAppendages(
      queryParsed.suffixAlphaTokens,
      candidateParsed.suffixAlphaTokens,
    );
  }

  private areSuffixesVariantAppendages(
    querySuffixes: string[],
    candidateSuffixes: string[],
  ): boolean {
    // Build greedy matching of suffix tokens
    const used = new Set<number>();

    for (const querySuffix of querySuffixes) {
      // Find best matching candidate suffix
      let bestIdx = -1;
      let bestDistance = Infinity;

      candidateSuffixes.forEach((candidateSuffix, idx) => {
        if (used.has(idx)) return;
        const distance = levenshtein(querySuffix, candidateSuffix);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIdx = idx;
        }
      });

      if (bestIdx >= 0 && bestDistance === 0) {
        // Exact match — not a mismatch
        used.add(bestIdx);
        continue;
      }

      // This suffix pair is mismatched — check if it qualifies as a variant appendage
      if (bestIdx >= 0) {
        used.add(bestIdx);
        const candidateSuffix = candidateSuffixes[bestIdx];
        if (!this.isVariantAppendage(querySuffix, candidateSuffix)) {
          return false;
        }
      } else {
        // Unmatched query suffix (extra token) — treat as variant if short
        if (querySuffix.length > 2) return false;
      }
    }

    // Check unmatched candidate suffixes
    for (let i = 0; i < candidateSuffixes.length; i++) {
      if (used.has(i)) continue;
      if (candidateSuffixes[i].length > 2) return false;
    }

    return true;
  }

  private isVariantAppendage(tokenA: string, tokenB: string): boolean {
    // (a) One is a prefix of the other
    if (tokenA.startsWith(tokenB) || tokenB.startsWith(tokenA)) return true;

    // (b) The shorter token has length ≤ 2
    const minLength = Math.min(tokenA.length, tokenB.length);
    return minLength <= 2;
  }
}
