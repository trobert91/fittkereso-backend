import { Injectable } from '@nestjs/common';
import type {
  ProductSpecs,
  SpecMatchDetails,
  SpecMatchDetail,
  SpecMatchResult,
  SpecTolerance,
} from '@fittkereso-backend/database';
import { compact, isNil, isEmpty } from 'lodash';

const NUMERIC_TOLERANCE_PERCENT = 5;

/**
 * Weight applied to each primary spec contradiction in the affinity score.
 * A single primary contradiction cancels out two confirmations.
 */
const CONTRADICTION_WEIGHT = 2;

/**
 * Weight applied to each matcher spec contradiction in the affinity score.
 * A single matcher contradiction cancels out one confirmation (softer than primary).
 */
const MATCHER_CONTRADICTION_WEIGHT = 1;

@Injectable()
export class SpecComparisonService {
  /**
   * Structured spec comparison. When primarySpecs is provided, only those keys
   * are compared. Otherwise falls back to all shared keys.
   */
  public compareSpecs(params: {
    specsA: ProductSpecs | undefined;
    specsB: ProductSpecs | undefined;
    primarySpecs?: string[];
    matcherSpecs?: string[];
    matcherSpecHierarchies?: Record<string, Record<string, string[]>>;
    specTolerances?: Record<string, SpecTolerance>;
  }): SpecMatchDetails {
    const {
      specsA,
      specsB,
      primarySpecs,
      matcherSpecs,
      matcherSpecHierarchies,
      specTolerances,
    } = params;

    const emptyResult: SpecMatchDetails = {
      comparableCount: 0,
      matchingCount: 0,
      primaryMismatches: 0,
      matcherSpecMismatches: 0,
      nonPrimaryMismatches: 0,
      details: [],
    };

    if (!specsA || !specsB) {
      return emptyResult;
    }

    const hasSpecConfig = !isEmpty(primarySpecs) || !isEmpty(matcherSpecs);
    const keysToCompare = hasSpecConfig
      ? [...new Set([...(primarySpecs ?? []), ...(matcherSpecs ?? [])])]
      : this.getSharedKeys(specsA, specsB);

    if (isEmpty(keysToCompare)) {
      return emptyResult;
    }

    const primarySpecSet = new Set(primarySpecs ?? []);
    const matcherSpecSet = new Set(matcherSpecs ?? []);
    const details: SpecMatchDetail[] = [];
    let comparableCount = 0;
    let matchingCount = 0;
    let primaryMismatches = 0;
    let matcherSpecMismatches = 0;
    let nonPrimaryMismatches = 0;

    for (const key of keysToCompare) {
      const valueA = specsA[key];
      const valueB = specsB[key];

      if (isNil(valueA)) {
        continue;
      }

      const isPrimary = primarySpecSet.has(key);
      const isMatcher = !isPrimary && matcherSpecSet.has(key);

      // Missing value on either side isn't a contradiction — webshops rarely
      // publish every spec field, so we can't assume an absent value means
      // "different." Skip the key entirely rather than counting it as a
      // mismatch (primary or matcher).
      if (isNil(valueB)) {
        continue;
      }

      comparableCount++;
      const specHierarchy = matcherSpecHierarchies?.[key];
      const matchResult = this.compareValues(
        valueA,
        valueB,
        specHierarchy,
        specTolerances?.[key],
      );

      if (matchResult === 'match' || matchResult === 'compatible') {
        matchingCount++;
      } else if (isPrimary) {
        primaryMismatches++;
      } else if (isMatcher) {
        matcherSpecMismatches++;
      } else {
        nonPrimaryMismatches++;
      }

      details.push({
        key,
        isPrimary,
        isMatcher,
        valueA,
        valueB,
        match: matchResult,
      });
    }

    return {
      comparableCount,
      matchingCount,
      primaryMismatches,
      matcherSpecMismatches,
      nonPrimaryMismatches,
      details,
    };
  }

  /**
   * Normalized spec affinity score in [-1.0, 1.0].
   *
   * Iterates all keys in specsA and checks against specsB.
   * Returns 0 when either side has no specs (neutral).
   */
  public computeSpecSimilarityScore(
    specsA: ProductSpecs | undefined,
    specsB: ProductSpecs | undefined,
    matcherSpecHierarchies?: Record<string, Record<string, string[]>>,
    primarySpecs?: string[],
    matcherSpecs?: string[],
    specTolerances?: Record<string, SpecTolerance>,
  ): number {
    if (!specsA || !specsB) return 0;

    const hasSpecConfig = !isEmpty(primarySpecs) || !isEmpty(matcherSpecs);
    const keysToCompare = hasSpecConfig
      ? [...new Set([...(primarySpecs ?? []), ...(matcherSpecs ?? [])])]
      : Object.keys(specsA).filter((key) => !isNil(specsA[key]));

    if (isEmpty(keysToCompare)) return 0;

    const primarySpecSet = new Set(primarySpecs ?? []);
    const matcherSpecSet = new Set(matcherSpecs ?? []);

    let confirmed = 0;
    let contradictions = 0;
    let weightedContradictions = 0;

    for (const key of keysToCompare) {
      const valueA = specsA[key];
      const valueB = specsB[key];
      if (isNil(valueA)) continue;

      // Missing value on the other side isn't a contradiction — webshops
      // rarely publish every spec field, so an absent value shouldn't be
      // penalized as a mismatch. Skip the key rather than counting it.
      if (isNil(valueB)) continue;

      const specHierarchy = matcherSpecHierarchies?.[key];
      const result = this.compareValues(
        valueA,
        valueB,
        specHierarchy,
        specTolerances?.[key],
      );

      if (result === 'match' || result === 'compatible') {
        confirmed++;
      } else {
        contradictions++;
        const isPrimary = primarySpecSet.has(key);
        const isMatcher = !isPrimary && matcherSpecSet.has(key);
        weightedContradictions += isMatcher
          ? MATCHER_CONTRADICTION_WEIGHT
          : CONTRADICTION_WEIGHT;
      }
    }

    const compared = confirmed + contradictions;
    if (compared === 0) return 0;

    return (confirmed - weightedContradictions) / compared;
  }

  // ─── Value Comparison ─────────────────────────────────────────────────────

  /**
   * Compare two spec values, returning 'match', 'compatible', or 'mismatch'.
   *
   * Handles all ProductSpecs value types: string, number, boolean, string[].
   * When at least one side is a string, applies number parsing, hierarchy check,
   * and fuzzy string matching.
   */
  private compareValues(
    valueA: string | number | boolean | string[],
    valueB: string | number | boolean | string[],
    hierarchy?: Record<string, string[]>,
    tolerance?: SpecTolerance,
  ): SpecMatchResult {
    // Both numbers — use tolerance
    if (typeof valueA === 'number' && typeof valueB === 'number') {
      return this.isNumberWithinTolerance(valueA, valueB, tolerance)
        ? 'match'
        : 'mismatch';
    }

    // Both booleans — exact
    if (typeof valueA === 'boolean' && typeof valueB === 'boolean') {
      return valueA === valueB ? 'match' : 'mismatch';
    }

    // Both arrays — subset match
    if (Array.isArray(valueA) && Array.isArray(valueB)) {
      return this.isArraySubsetMatch(valueA, valueB) ? 'match' : 'mismatch';
    }

    // At least one is a string (or mixed types) — coerce to string and apply full matching
    const stringA = this.toStringValue(valueA);
    const stringB = this.toStringValue(valueB);

    // Try numeric parse from both string values
    // A spec published as `"2024"` by one shop and `2024` by another lands here
    // rather than in the numeric branch above, so the override has to apply on
    // both paths or it would depend on how a scraper happened to type the value.
    const numA = this.extractStandaloneNumber(stringA);
    const numB = this.extractStandaloneNumber(stringB);
    if (numA !== null && numB !== null) {
      return this.isNumberWithinTolerance(numA, numB, tolerance)
        ? 'match'
        : 'mismatch';
    }

    // Hierarchy compatibility check
    if (hierarchy && this.isHierarchyCompatible(stringA, stringB, hierarchy)) {
      return 'compatible';
    }

    // Fuzzy string match
    if (this.fuzzyStringMatch(stringA, stringB)) {
      return 'match';
    }

    return 'mismatch';
  }

  // ─── Numeric Helpers ──────────────────────────────────────────────────────

  /**
   * Whether two numbers are close enough to count as the same value.
   *
   * Relative by default, which is right for magnitudes: 750Wh and 760Wh are the
   * same battery however the two shops rounded it. It is wrong for
   * identity-bearing integers, where the same 5% spans the entire plausible
   * range — every model year between 2015 and 2030 is within 5% of every other,
   * so a year could never contradict anything. `tolerance` is the per-spec
   * override that fixes those, `{ absolute: 0 }` meaning exact.
   */
  private isNumberWithinTolerance(
    numberA: number,
    numberB: number,
    tolerance?: SpecTolerance,
  ): boolean {
    if (numberA === numberB) return true;

    const difference = Math.abs(numberA - numberB);

    // Checked before `percent` so `{ absolute: 0 }` is honoured — a plain
    // truthiness test would read 0 as "unset" and silently fall through to the
    // relative default, which is the exact bug this option exists to fix.
    if (!isNil(tolerance?.absolute)) {
      return difference <= tolerance.absolute;
    }

    const max = Math.max(Math.abs(numberA), Math.abs(numberB));
    if (max === 0) return true;

    const percentDiff = (difference / max) * 100;
    return percentDiff <= (tolerance?.percent ?? NUMERIC_TOLERANCE_PERCENT);
  }

  /**
   * Extract a numeric value only when it's a standalone spec value (single numeric segment).
   * Returns null for compound tokens like "5k2k" (two segments) or "5120x2160".
   */
  private extractStandaloneNumber(value: string): number | null {
    const numericSegments = value.match(/\d+(?:\.\d+)?/g);
    if (!numericSegments || numericSegments.length !== 1) return null;
    return parseFloat(numericSegments[0]);
  }

  // ─── Hierarchy ────────────────────────────────────────────────────────────

  /**
   * Returns true if one value resolves to the parent and the other to one of
   * its children. A value resolves to a name either by exact equality or by
   * containing it as a whitespace/hyphen-delimited token. The token-containment
   * rule lets modifier-prefixed values like "matte WOLED" or "glossy QD-OLED"
   * map to the same hierarchy group as the bare "OLED" / "QD-OLED" entry,
   * while preserving sibling values (IPS vs VA) as mismatches.
   * Example: hierarchy = { "OLED": ["QD-OLED", "W-OLED", "WOLED"] }
   *   isHierarchyCompatible("OLED", "QD-OLED") → true
   *   isHierarchyCompatible("matte WOLED", "OLED") → true
   *   isHierarchyCompatible("glossy QD-OLED", "QD-OLED") → true
   *   isHierarchyCompatible("IPS", "VA") → false (siblings)
   */
  private isHierarchyCompatible(
    valueA: string,
    valueB: string,
    hierarchy: Record<string, string[]>,
  ): boolean {
    const a = valueA.toLowerCase().trim();
    const b = valueB.toLowerCase().trim();

    for (const [parent, children] of Object.entries(hierarchy)) {
      const normalizedParent = parent.toLowerCase().trim();
      const normalizedChildren = children.map((child) =>
        child.toLowerCase().trim(),
      );

      const aIsParent = this.matchesHierarchyName(a, normalizedParent);
      const bIsParent = this.matchesHierarchyName(b, normalizedParent);
      const aIsChild = normalizedChildren.some((child) =>
        this.matchesHierarchyName(a, child),
      );
      const bIsChild = normalizedChildren.some((child) =>
        this.matchesHierarchyName(b, child),
      );

      if ((aIsParent && bIsChild) || (bIsParent && aIsChild)) {
        return true;
      }
    }

    return false;
  }

  private matchesHierarchyName(value: string, name: string): boolean {
    if (value === name) return true;
    const tokens = new Set(value.split(/[\s-]+/).filter(Boolean));
    return tokens.has(name);
  }

  // ─── Array Matching ───────────────────────────────────────────────────────

  /**
   * Returns true if one array's elements are all contained in the other (subset match).
   * Comparison is case-insensitive and trimmed.
   */
  private isArraySubsetMatch(arrayA: string[], arrayB: string[]): boolean {
    if (isEmpty(arrayA) || isEmpty(arrayB)) return false;

    const normalizedA = arrayA.map((item) => String(item).toLowerCase().trim());
    const normalizedB = arrayB.map((item) => String(item).toLowerCase().trim());

    const aIsSubsetOfB = normalizedA.every((item) =>
      normalizedB.includes(item),
    );
    if (aIsSubsetOfB) return true;

    const bIsSubsetOfA = normalizedB.every((item) =>
      normalizedA.includes(item),
    );
    return bIsSubsetOfA;
  }

  // ─── Fuzzy String Matching ────────────────────────────────────────────────

  /**
   * Fuzzy string match: normalize both values (strip units, lowercase, trim),
   * check word-boundary containment, and apply Levenshtein distance for short values.
   */
  private fuzzyStringMatch(
    inputValue: string,
    candidateValue: string,
  ): boolean {
    const normalizedInput = this.normalizeSpecValue(inputValue);
    const normalizedCandidate = this.normalizeSpecValue(candidateValue);

    if (normalizedInput === normalizedCandidate) return true;

    // Word-boundary containment
    const words = compact(normalizedInput.split(/\s+/));
    if (
      !isEmpty(words) &&
      words.every((word) =>
        new RegExp(`\\b${this.escapeRegex(word)}\\b`, 'i').test(
          normalizedCandidate,
        ),
      )
    ) {
      return true;
    }

    // Levenshtein distance for short values — skip when both sides are purely numeric,
    // since numeric specs must match within tolerance (handled by the caller's numeric check).
    // e.g. "39" vs "34" would otherwise match at edit-distance 1, defeating contradiction detection.
    const inputIsNumeric = /^\d+(\.\d+)?$/.test(normalizedInput);
    const candidateIsNumeric = /^\d+(\.\d+)?$/.test(normalizedCandidate);
    if (!inputIsNumeric || !candidateIsNumeric) {
      if (normalizedInput.length > 0 && normalizedCandidate.length > 0) {
        const threshold = normalizedInput.length <= 6 ? 1 : 2;
        if (
          this.levenshtein(normalizedInput, normalizedCandidate) <= threshold
        ) {
          return true;
        }
      }
    }

    return false;
  }

  private normalizeSpecValue(value: string): string {
    return value
      .toLowerCase()
      .replace(/\b(variant|version|model|inch|mm|gb|hz|nits?)\b/gi, '')
      .replace(/"/g, '')
      .replace(/-/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  private toStringValue(value: string | number | boolean | string[]): string {
    if (Array.isArray(value)) return value.join(', ');
    return String(value).toLowerCase().trim();
  }

  private getSharedKeys(specsA: ProductSpecs, specsB: ProductSpecs): string[] {
    const keysA = Object.keys(specsA);
    const keySetB = new Set(Object.keys(specsB));
    return keysA.filter((key) => keySetB.has(key));
  }
}
