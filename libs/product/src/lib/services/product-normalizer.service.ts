import { Injectable } from '@nestjs/common';
import { uniq } from 'lodash';

/**
 * The words a listing's `normalizedModel` is built from (normalizeModel):
 * accents and case dropped, punctuation other than "+" splitting words,
 * letters and digits split. A "+" stays on its word ("Move+", "+EQ"), and one
 * standing alone joins the word before it ("E +" is "e+"). Words with no
 * letter or digit go. Exported so the identity extraction can check its model
 * against the title word for word, the same way.
 */
export function identityWords(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+\+(?=\s|$)/g, '+')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(' ')
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

@Injectable()
export class ProductNormalizerService {
  /**
   * The key two listings of one model share: a listing's `model` reduced to
   * its sorted, de-duplicated words (identityWords), so it can be compared for
   * equality. Undefined when nothing is left.
   *
   * Every step removes a difference that says nothing about which model it
   * is, and keeps every word that does:
   * - accents and case go ("Trapéz" and "TRAPEZ" agree);
   * - "+" stays on its word ("Move" and "Move+" are different bikes);
   * - other punctuation splits words ("C:62", "400X/FE");
   * - letters and digits split ("CX830" and "CX 830" agree, as do "ONE22" and
   *   "ONE 22");
   * - the words of each of `brands` go, wherever they stand;
   * - each of `dropValues` goes where its words stand in a row: the listing's
   *   own values of the specs a key leaves out (its year, its wheel size), in
   *   case the extraction kept one.
   *
   * Lossy by construction: splitting then sorting lets "E5 … 1" and
   * "E1 … 5" collide. Matching never acts on a key alone: the spec gates
   * still apply.
   */
  public normalizeModel({
    text,
    brands = [],
    dropValues = [],
  }: {
    text: string | undefined;
    brands?: (string | undefined)[];
    dropValues?: string[];
  }): string | undefined {
    const brandWords = new Set(brands.flatMap((brand) => identityWords(brand)));
    const words = dropValues
      .reduce(
        (remaining, value) => this.withoutRun(remaining, identityWords(value)),
        identityWords(text),
      )
      .filter((word) => !brandWords.has(word));

    return uniq(words).sort().join(' ') || undefined;
  }

  /** `words` without every occurrence of `run` as consecutive words. */
  private withoutRun(words: string[], run: string[]): string[] {
    if (run.length === 0) return words;

    const kept: string[] = [];
    for (let i = 0; i < words.length; ) {
      const matches = run.every((word, offset) => words[i + offset] === word);
      if (matches) {
        i += run.length;
      } else {
        kept.push(words[i]);
        i += 1;
      }
    }
    return kept;
  }
}
