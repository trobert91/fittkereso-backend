import { levenshtein } from '@fittkereso-backend/utils';
import { identityWords } from '../product-normalizer.service';

/** Words kept on each side of a keyword, unless the source sets its own. */
export const DEFAULT_EVIDENCE_WINDOW_WORDS = 10;

/** The most characters of excerpts one listing sends, unless the source sets its own. */
export const DEFAULT_EVIDENCE_MAX_CHARS = 3000;

/** Below this length a keyword must match exactly or as a word's start: one
 *  edit away, "city" would also be "cite". */
const MIN_TYPO_LENGTH = 6;

/**
 * The parts of a description that can matter to the identity extraction: the
 * text around each of the category's `evidenceKeywords`, rather than the whole
 * description (long, and full of the brand's and other models' talk) or none
 * of it.
 *
 * `text` is plain text (htmlToText). Words are compared as identityWords
 * normalises them — accents, case and punctuation aside — and a word matches a
 * keyword when it:
 * - is the keyword;
 * - starts with it, which takes Hungarian suffixes and compounds ("túrabringa"
 *   for "túra", "gyerekkerékpár" for "gyerek");
 * - for a keyword of 6 letters or more, is one typo away, alone or before a
 *   suffix ("treking", "trekingkerékpár").
 * A keyword of several words matches them in a row.
 *
 * Each hit keeps `windowWords` words on each side, as the text writes them;
 * overlapping windows become one excerpt. Excerpts come in the text's order,
 * as many as fit in `maxChars`. Empty when nothing matches.
 */
export function findDescriptionEvidence(
  text: string,
  keywords: string[],
  options: { windowWords?: number; maxChars?: number } = {},
): string[] {
  const windowWords = options.windowWords ?? DEFAULT_EVIDENCE_WINDOW_WORDS;
  const maxChars = options.maxChars ?? DEFAULT_EVIDENCE_MAX_CHARS;
  const keywordParts = keywords.map((keyword) => identityWords(keyword)).filter((parts) => parts.length);

  // The text's words as written, and the normalised parts each one holds
  // ("e-MTB" is "e" and "mtb"), each part pointing back at its word.
  const words = text.split(/\s+/).filter(Boolean);
  const parts = words.flatMap((word, index) => identityWords(word).map((part) => ({ part, index })));

  // Word ranges [from, to), with the first keyword's word in each.
  const windows: { from: number; to: number; hit: number }[] = [];
  for (let at = 0; at < parts.length; at++) {
    const hit = keywordParts.some((keyword) =>
      keyword.every((part, offset) => at + offset < parts.length && matches(parts[at + offset].part, part)),
    );
    if (!hit) continue;
    const word = parts[at].index;
    const from = Math.max(0, word - windowWords);
    const to = Math.min(words.length, word + windowWords + 1);
    const last = windows[windows.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else windows.push({ from, to, hit: word });
  }

  // Word by word, so the excerpt that reaches the cap is cut rather than
  // dropped — as long as the cut keeps its keyword.
  const excerpts: string[] = [];
  let length = 0;
  for (const { from, to, hit } of windows) {
    const kept: string[] = [];
    for (const word of words.slice(from, to)) {
      if (length + word.length > maxChars) break;
      kept.push(word);
      length += word.length + 1;
    }
    if (from + kept.length > hit) excerpts.push(kept.join(' '));
    if (kept.length < to - from) break;
  }
  return excerpts;
}

function matches(word: string, keyword: string): boolean {
  if (word.startsWith(keyword)) return true;
  // A typo rarely sits in both of the first two letters; skipping those words
  // keeps a long description from costing a distance per word per keyword.
  if (keyword.length < MIN_TYPO_LENGTH || word.length < keyword.length - 1) return false;
  if (word[0] !== keyword[0] && word[1] !== keyword[1]) return false;
  // One typo, in the word or before its suffix: the word's start one letter
  // shorter, as long, or one longer than the keyword.
  return [keyword.length - 1, keyword.length, keyword.length + 1].some(
    (length) => length <= word.length && levenshtein(word.slice(0, length), keyword) <= 1,
  );
}
