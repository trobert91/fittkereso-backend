import type { SpecTolerance } from '@fittkereso-backend/database';
import { compact, escapeRegExp, isEmpty, isNil } from 'lodash';
import { levenshtein } from './name-similarity';

/** A present spec value: ProductSpecs' value types without `undefined`. */
export type SpecValue = string | number | boolean | string[];

/** `compatible`: one value is a hierarchy parent of the other. */
export type SpecMatchResult = 'match' | 'compatible' | 'mismatch';

/** Relative tolerance for two numbers when the spec has no override. */
const NUMERIC_TOLERANCE_PERCENT = 5;

const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/**
 * Compares two present values of one spec (ported from
 * SpecComparisonService.compareValues). Numbers match within tolerance,
 * booleans exactly, arrays when one is a subset of the other. Anything
 * involving a string is compared by its number when both sides hold exactly
 * one, then by the category's value hierarchy, then by a fuzzy string match.
 */
export function compareSpecValue(
  valueA: SpecValue,
  valueB: SpecValue,
  hierarchy?: Record<string, string[]>,
  tolerance?: SpecTolerance,
): SpecMatchResult {
  if (typeof valueA === 'number' && typeof valueB === 'number') {
    return isNumberWithinTolerance(valueA, valueB, tolerance)
      ? 'match'
      : 'mismatch';
  }
  if (typeof valueA === 'boolean' && typeof valueB === 'boolean') {
    return valueA === valueB ? 'match' : 'mismatch';
  }
  if (Array.isArray(valueA) && Array.isArray(valueB)) {
    return isArraySubsetMatch(valueA, valueB) ? 'match' : 'mismatch';
  }

  const stringA = toStringValue(valueA);
  const stringB = toStringValue(valueB);

  // A spec published as "2024" by one shop and 2024 by another lands here
  // rather than in the numeric branch, so the tolerance has to apply on both
  // paths or the result would depend on how a scraper typed the value.
  const numberA = extractStandaloneNumber(stringA);
  const numberB = extractStandaloneNumber(stringB);
  if (numberA !== null && numberB !== null) {
    return isNumberWithinTolerance(numberA, numberB, tolerance)
      ? 'match'
      : 'mismatch';
  }

  if (hierarchy && isHierarchyCompatible(stringA, stringB, hierarchy)) {
    return 'compatible';
  }

  return fuzzyStringMatch(stringA, stringB) ? 'match' : 'mismatch';
}

/**
 * Relative by default, which suits magnitudes: 750Wh and 760Wh are the same
 * battery however two shops rounded it. Identity-bearing integers need the
 * per-spec override — at 5% every model year from 2015 to 2030 matches every
 * other — and `{ absolute: 0 }` means exact.
 */
function isNumberWithinTolerance(
  numberA: number,
  numberB: number,
  tolerance?: SpecTolerance,
): boolean {
  if (numberA === numberB) return true;

  const difference = Math.abs(numberA - numberB);

  // Checked before `percent`, and with isNil, so `absolute: 0` isn't read as unset.
  const absolute = tolerance?.absolute;
  if (!isNil(absolute)) {
    return difference <= absolute;
  }

  const max = Math.max(Math.abs(numberA), Math.abs(numberB));
  if (max === 0) return true;

  return (
    (difference / max) * 100 <= (tolerance?.percent ?? NUMERIC_TOLERANCE_PERCENT)
  );
}

/** The value's number when it has exactly one numeric segment ("5120x2160" has two). */
function extractStandaloneNumber(value: string): number | null {
  const numericSegments = value.match(/\d+(?:\.\d+)?/g);
  if (!numericSegments || numericSegments.length !== 1) return null;
  return parseFloat(numericSegments[0]);
}

/**
 * True when one value resolves to a parent and the other to one of its
 * children. A value resolves to a name by equality or by containing it as a
 * whitespace/hyphen-delimited token, so "matte WOLED" maps to the "WOLED"
 * entry, while siblings (IPS vs VA) stay a mismatch.
 */
function isHierarchyCompatible(
  valueA: string,
  valueB: string,
  hierarchy: Record<string, string[]>,
): boolean {
  const a = valueA.toLowerCase().trim();
  const b = valueB.toLowerCase().trim();

  return Object.entries(hierarchy).some(([parent, children]) => {
    const normalizedParent = parent.toLowerCase().trim();
    const normalizedChildren = children.map((child) =>
      child.toLowerCase().trim(),
    );
    const isChild = (value: string) =>
      normalizedChildren.some((child) => matchesHierarchyName(value, child));

    return (
      (matchesHierarchyName(a, normalizedParent) && isChild(b)) ||
      (matchesHierarchyName(b, normalizedParent) && isChild(a))
    );
  });
}

function matchesHierarchyName(value: string, name: string): boolean {
  return value === name || compact(value.split(/[\s-]+/)).includes(name);
}

/** Whether one array's elements are all in the other, case-insensitively. */
function isArraySubsetMatch(arrayA: string[], arrayB: string[]): boolean {
  if (isEmpty(arrayA) || isEmpty(arrayB)) return false;

  const normalizedA = arrayA.map((item) => String(item).toLowerCase().trim());
  const normalizedB = arrayB.map((item) => String(item).toLowerCase().trim());

  return (
    normalizedA.every((item) => normalizedB.includes(item)) ||
    normalizedB.every((item) => normalizedA.includes(item))
  );
}

/**
 * Equal once normalized (units stripped, lowercased), every word of the input
 * found whole in the candidate, or a small edit distance — except between two
 * plain numbers, where "39" vs "34" is one edit but a real contradiction.
 */
function fuzzyStringMatch(inputValue: string, candidateValue: string): boolean {
  const input = normalizeSpecValue(inputValue);
  const candidate = normalizeSpecValue(candidateValue);

  if (input === candidate) return true;

  const words = compact(input.split(/\s+/));
  if (
    !isEmpty(words) &&
    words.every((word) =>
      new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(candidate),
    )
  ) {
    return true;
  }

  if (isEmpty(input) || isEmpty(candidate)) return false;
  if (PLAIN_NUMBER.test(input) && PLAIN_NUMBER.test(candidate)) return false;

  const threshold = input.length <= 6 ? 1 : 2;
  return levenshtein(input, candidate) <= threshold;
}

function normalizeSpecValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(variant|version|model|inch|mm|gb|hz|nits?)\b/gi, '')
    .replace(/"/g, '')
    .replace(/-/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function toStringValue(value: SpecValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value).toLowerCase().trim();
}
