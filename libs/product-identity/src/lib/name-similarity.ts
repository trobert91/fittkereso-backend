import type { NameSimilarity } from '@fittkereso-backend/database';

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

/** Both similarities of two name keys; `trigram` is pg_trgm's `similarity()` from recall. */
export function nameSimilarity(
  trigram: number,
  queryKey: string,
  candidateKey: string,
): NameSimilarity {
  return { trigram, levenshtein: levenshteinSimilarity(queryKey, candidateKey) };
}

/** A candidate's score before gates: the better similarity, as 0–100. */
export function baseScore(similarity: NameSimilarity): number {
  return Math.round(100 * Math.max(similarity.trigram, similarity.levenshtein));
}
