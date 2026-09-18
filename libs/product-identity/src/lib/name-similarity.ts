import type { NameSimilarity } from '@fittkereso-backend/database';
import { clamp } from 'lodash';
import {
  ALIGNMENT_WEIGHT,
  SUBSTITUTION_COST,
  OMISSION_COST,
} from './product-identity.constants';

/** Edit distance over code points, so an accented letter or an emoji is one edit. */
export function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const substitution =
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

/** 1 − edits / the longer key's length, in [0, 1]; two empty keys are identical. */
export function levenshteinSimilarity(a: string, b: string): number {
  const longer = Math.max(Array.from(a).length, Array.from(b).length);
  return longer === 0 ? 1 : 1 - levenshtein(a, b) / longer;
}

/** Each word padded with two leading spaces and one trailing, as pg_trgm does. */
function trigramsOf(input: string): Set<string> {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const trigrams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      trigrams.add(padded.slice(i, i + 3));
    }
  }
  return trigrams;
}

/**
 * pg_trgm's `similarity()`, computed here rather than read from the recall row.
 *
 * Recall reports its number against the value it matched — for an alias row,
 * the *raw* alias, which the finder then re-keys before comparing. The old
 * `max(trigram, levenshtein)` hid that mismatch; a blend would average in a
 * similarity measured on different strings, so all three now see the same
 * pair. `RecallRow.trigram` still orders the SQL, which is all it is for.
 *
 * `name-similarity.spec.ts` checks this against every pg_trgm value in
 * `catalog.json` — 1326 real pairs, Postgres' own numbers.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigramsOf(a);
  const right = trigramsOf(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const trigram of left) if (right.has(trigram)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * How much identity one token carries, in [0, 1]. 0 for a token every product
 * of the brand shares — `macina` is in all 58 KTM e-bikes and says nothing —
 * and 1 for one only this product has. `TokenIdfService` builds these from the
 * stored keys of the same brand and category.
 */
export type TokenIdf = (token: string) => number;

/** Every token weighs the same: the fallback when no corpus statistics exist. */
export const FLAT_IDF: TokenIdf = () => 1;

function tokensOf(key: string): string[] {
  return key.split(/\s+/).filter(Boolean);
}

/**
 * Whether two tokens name the same thing. A digit makes a token a model
 * number, where "720" and "725" are different bikes, so those only ever match
 * exactly; longer words tolerate one typo.
 */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  return Math.min(a.length, b.length) >= 5 && levenshtein(a, b) <= 1;
}

/** The tokens each key has that the other does not, after pairing off the rest. */
export function alignTokens(
  queryKey: string,
  candidateKey: string,
): { onlyQuery: string[]; onlyCandidate: string[] } {
  const candidateTokens = tokensOf(candidateKey);
  const paired = new Set<number>();
  const onlyQuery: string[] = [];

  for (const token of tokensOf(queryKey)) {
    const index = candidateTokens.findIndex(
      (candidate, at) => !paired.has(at) && sameToken(token, candidate),
    );
    if (index < 0) onlyQuery.push(token);
    else paired.add(index);
  }

  return {
    onlyQuery,
    onlyCandidate: candidateTokens.filter((_, at) => !paired.has(at)),
  };
}

/**
 * The name similarity that knows what kind of difference it is looking at,
 * in [0, 1].
 *
 * Leftover tokens pair off into **substitutions** — each side says something
 * different in the same slot, which is two products ("master" vs "prestige")
 * — and whatever is left over is an **omission**, one shop simply printing
 * more of the name ("glorious", a colourway one shop keeps). A substitution
 * costs far more than an omission, and both cost in proportion to how much
 * identity the token carries, so the brand's own line name is free.
 *
 * This is what neither trigram nor Levenshtein can see: to them "glorious"
 * and "prestige" are both "one token differs", which is why both land in the
 * same score band today.
 */
export function alignmentSimilarity(
  queryKey: string,
  candidateKey: string,
  idf: TokenIdf = FLAT_IDF,
): number {
  const { onlyQuery, onlyCandidate } = alignTokens(queryKey, candidateKey);
  const descending = (a: number, b: number) => b - a;
  const queryWeights = onlyQuery.map(idf).sort(descending);
  const candidateWeights = onlyCandidate.map(idf).sort(descending);

  // The heaviest leftovers pair off first, so the cost reflects the most
  // identity-bearing disagreement rather than the order tokens happen to sit in.
  const substitutions = Math.min(queryWeights.length, candidateWeights.length);
  let penalty = 0;
  for (let i = 0; i < substitutions; i++) {
    penalty += SUBSTITUTION_COST * Math.max(queryWeights[i], candidateWeights[i]);
  }
  for (const weight of [
    ...queryWeights.slice(substitutions),
    ...candidateWeights.slice(substitutions),
  ]) {
    penalty += OMISSION_COST * weight;
  }

  return clamp(1 - penalty / 100, 0, 1);
}

/** Every similarity of two name keys, all three measured on the same pair. */
export function nameSimilarity(
  queryKey: string,
  candidateKey: string,
  idf: TokenIdf = FLAT_IDF,
): NameSimilarity {
  return {
    trigram: trigramSimilarity(queryKey, candidateKey),
    levenshtein: levenshteinSimilarity(queryKey, candidateKey),
    alignment: alignmentSimilarity(queryKey, candidateKey, idf),
  };
}

/**
 * A candidate's score before gates: a weighted mean of the three, as 0–100.
 *
 * The three are blended rather than maxed because they fail differently —
 * trigram is blind to word identity, Levenshtein is blind to word boundaries,
 * and alignment is blind to spelling. Alignment carries `ALIGNMENT_WEIGHT`
 * because it is the only one that separates an omission from a substitution;
 * the character metrics are kept as ballast, since alignment alone lands on a
 * coarse lattice of a few discrete values.
 *
 * `alignment` is absent on `ProductDuplicatePair` rows written before the
 * blend existed, which are only ever displayed — those fall back to the
 * previous rule so an old row still renders a sane number.
 */
export function baseScore(similarity: NameSimilarity): number {
  const { trigram, levenshtein: edit, alignment } = similarity;
  if (alignment === undefined) {
    return Math.round(100 * Math.max(trigram, edit));
  }

  return Math.round(
    (100 * (trigram + edit + ALIGNMENT_WEIGHT * alignment)) /
      (2 + ALIGNMENT_WEIGHT),
  );
}
