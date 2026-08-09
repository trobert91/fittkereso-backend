import { editDistanceRatio } from './edit-distance';

/**
 * Strips markdown link syntax from text, replacing `[text](url)` with just `text`.
 * Also removes orphaned brackets `[text]` that remain when an LLM copies
 * the link text but drops the URL portion.
 * e.g. "MSI MPG [341CQPX](https://msi.com/...)" → "MSI MPG 341CQPX"
 * e.g. "MSI MPG [341CQPX]" → "MSI MPG 341CQPX"
 *
 * Preserves array-index style brackets like `array[0]` or `scores[i]`
 * where a word character immediately precedes `[`.
 */
export function stripMarkdownLinks(text: string): string {
  // First strip full markdown links [text](url)
  let result = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Then strip orphaned brackets [text] left by LLMs copying partial markdown.
  // Negative lookbehind (?<!\w) avoids stripping array-index patterns like arr[0].
  result = result.replace(/(?<!\w)\[([^\]]+)\]/g, '$1');
  return result;
}

/**
 * Strips punctuation characters from text, preserving only letters, digits,
 * and whitespace. Collapses resulting multiple spaces into a single space.
 *
 * Used as a normalization step for fuzzy text matching — NOT for display.
 */
export function stripPunctuation(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether `text` appears in `source` using exact match
 * with a short-text fallback (all words present individually)
 * and a punctuation-normalized fallback for longer texts.
 *
 * Used to filter LLM-hallucinated textSpans and quotes that don't
 * actually appear in the source comment.
 */
export function textExistsInSource(text: string, source: string): boolean {
  const normalizedText = stripMarkdownLinks(text).toLowerCase().trim();
  const normalizedSource = stripMarkdownLinks(source).toLowerCase();

  if (!normalizedText) return false;

  // Strategy 1: Exact substring match
  if (normalizedSource.includes(normalizedText)) return true;

  // Strategy 2: Short-text fallback — for spans ≤3 words, accept if all
  // significant words (length > 2) appear individually
  const words = normalizedText.split(' ');
  if (
    words.length <= 3 &&
    words.every((word) => word.length <= 2 || normalizedSource.includes(word))
  ) {
    return true;
  }

  // Strategy 3: Punctuation-normalized fallback for longer texts (4+ words).
  // Catches minor punctuation differences (missing commas, periods, etc.)
  // while still requiring the full word sequence to appear as a substring.
  if (words.length >= 4) {
    const strippedText = stripPunctuation(normalizedText);
    const strippedSource = stripPunctuation(normalizedSource);
    if (strippedText && strippedSource.includes(strippedText)) {
      return true;
    }
  }

  return false;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.9;

/**
 * Checks whether two text strings are near-duplicates using
 * exact normalized match, substring containment, and bigram Dice similarity.
 *
 * Used to deduplicate quotes across multiple references/comments
 * where the same user may repeat their opinion in different threads.
 */
export function isNearDuplicateText(
  textA: string,
  textB: string,
  threshold = DEDUP_SIMILARITY_THRESHOLD,
): boolean {
  const normalizedA = stripPunctuation(textA.toLowerCase().trim());
  const normalizedB = stripPunctuation(textB.toLowerCase().trim());
  if (!normalizedA || !normalizedB) return false;

  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  return bigramDice(normalizedA, normalizedB) >= threshold;
}

/**
 * True when `longer` contains a window that is a near-duplicate of `shorter`.
 * After punctuation/case normalization, uses substring containment as the fast
 * path and falls back to a Levenshtein-based moving window for the "almost
 * contains" case (longer holds a slightly-edited restatement of shorter).
 *
 * Only fires when `shorter` is materially shorter than `longer` (length ratio
 * below `maxLengthRatio`, default 0.75). Comparing similar-length strings via a
 * window slide produces too many false positives, so callers should fall back
 * to a symmetric similarity check (e.g. `isNearDuplicateText`) for that case.
 */
export function containsNearDuplicateSubstring(
  longer: string,
  shorter: string,
  threshold = 0.85,
  maxLengthRatio = 0.75,
): boolean {
  const normalizedLonger = stripPunctuation(longer.toLowerCase().trim());
  const normalizedShorter = stripPunctuation(shorter.toLowerCase().trim());
  if (!normalizedLonger || !normalizedShorter) return false;
  if (normalizedShorter.length >= normalizedLonger.length) return false;
  if (normalizedShorter.length / normalizedLonger.length > maxLengthRatio) return false;

  if (normalizedLonger.includes(normalizedShorter)) return true;

  return slidingWindowEditDistanceRatio(normalizedShorter, normalizedLonger) >= threshold;
}

/**
 * Slides a window over `source` and returns the best edit-distance ratio
 * (1 - lev / maxLen) between `text` and any window of similar length.
 * Window size varies in [shorter*0.8, shorter*1.2] to allow minor expansions
 * inside the longer string.
 */
function slidingWindowEditDistanceRatio(text: string, source: string): number {
  if (text.length > source.length) return editDistanceRatio(text, source);

  const minLen = Math.max(1, Math.floor(text.length * 0.8));
  const maxLen = Math.min(source.length, Math.ceil(text.length * 1.2));
  let best = 0;

  for (let windowLen = minLen; windowLen <= maxLen; windowLen++) {
    for (let i = 0; i <= source.length - windowLen; i++) {
      if (i > 0 && source[i - 1] !== ' ') continue; // word-boundary start only
      const window = source.substring(i, i + windowLen);
      const score = editDistanceRatio(text, window);
      if (score > best) best = score;
      if (best >= 0.98) return best;
    }
  }
  return best;
}

/**
 * Minimum quality gate — filters obviously non-substantive quotes.
 * Only rejects quotes under 10 chars (noise like "Nah", "same", "yes").
 */
export function isSubstantiveQuote(text: string): boolean {
  return text.trim().length >= 10;
}

/**
 * Dice coefficient on character bigrams.
 * Returns 0..1 where 1 = identical bigram sets.
 */
export function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substring(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }

  const bigramsB = new Map<string, number>();
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.substring(i, i + 2);
    bigramsB.set(bg, (bigramsB.get(bg) ?? 0) + 1);
  }

  let intersection = 0;
  for (const [bg, countA] of bigramsA) {
    intersection += Math.min(countA, bigramsB.get(bg) ?? 0);
  }

  return (2 * intersection) / (a.length - 1 + b.length - 1);
}
