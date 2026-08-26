import { Injectable } from '@nestjs/common';

@Injectable()
export class ProductNormalizerService {
  /**
   * Produce the pg_trgm similarity key for a product: a compact, lowercased,
   * brand-less string of model identifiers.
   *
   * Brand is taken as input only to strip it from the source string; it is
   * NOT included in the output. Consumers that know the brand at query time
   * enforce it via SQL (brand.id = :brandId), which keeps the trigram key
   * free of brand-prefix noise and lets brand-less comment mentions match
   * cleanly.
   *
   * Three strategies, selected per-category via ProductCategoryConfig.normalizationStrategy:
   *
   * 'full-sorted' (default): keeps the whole brand-stripped string (lowercased,
   * whitespace-collapsed), then sorts the whitespace-delimited words
   * alphabetically before joining, so this key (and every pg_trgm
   * similarity() query against it — ProductFuzzySearchService, the nightly
   * dedup job's recall, Path 1's exact lookup) is insensitive to word-order
   * differences between sources' post-processed model strings (e.g. "Cross
   * Macina 720" vs. "Macina Cross 720"). See normalizeFullSorted(). Lossy by
   * construction — see that method's doc comment for the collision caveat.
   *
   * 'full': same as 'full-sorted' but without the word-sort — keeps the
   * whole brand-stripped string (lowercased, whitespace-collapsed only). Use
   * when word order is already reliable and the sort's collision risk isn't
   * worth taking. See normalizeFull() for details.
   *
   * 'digit-heuristic': split on whitespace to preserve word boundaries
   * (so "G5 C34G55TWWP" stays two tokens), and for each whitespace-bounded
   * word that contains a digit, keep all alphanumeric characters (dashes,
   * slashes and other glue characters are dropped, but everything they tie
   * together is preserved). So "34GN850P-B" → "34gn850pb", "39GS95QE-W" →
   * "39gs95qew", "XB271HU-bmiprz" → "xb271hubmiprz". Marketing words
   * (UltraGear, OLED, Pro, Swift, Gaming) are digit-free and fall out. Correct
   * when the model code is the one alphanumeric token in the name (monitors);
   * wrong for categories like bikes whose model line has no digits at all —
   * the heuristic would discard the entire model line.
   */
  public normalizeProduct({
    brand,
    model,
    displayName,
    strategy = 'full-sorted',
  }: {
    brand: string;
    model: string | undefined;
    displayName: string | undefined;
    strategy?: 'digit-heuristic' | 'full' | 'full-sorted';
  }): string {
    const source = model ?? displayName;
    if (!source) {
      throw new Error('Cannot normalize product with unknown name');
    }

    const withoutBrand = this.stripBrandPrefix(source, brand);

    if (strategy === 'full-sorted') {
      return this.normalizeFullSorted(withoutBrand);
    }

    if (strategy === 'full') {
      return this.normalizeFull(withoutBrand);
    }

    const words = withoutBrand.split(/\s+/).filter(Boolean);
    const keptWords = words
      .map((word) => {
        const cleaned = this.keepAlphanumeric(word);
        return /\d/.test(cleaned) ? cleaned : '';
      })
      .filter(Boolean);

    return keptWords.length > 0
      ? keptWords.join(' ')
      : this.keepAlphanumeric(this.longestAlphaChunk(words));
  }

  /**
   * Keeps the whole brand-stripped string — lowercased and whitespace-
   * collapsed only, no word-level discarding. For categories with no reliable
   * digit/alpha split between "identity" and "noise" (e.g. bikes, where the
   * model line has no digits at all). Relies on offer-level attributes
   * (size, color, ...) already having been stripped out of `model` upstream
   * by ProductSourcePostProcessService — this strategy does no semantic
   * stripping of its own, only the minimum transform needed for the result
   * to be a stable, collision-resistant DB key.
   */
  private normalizeFull(input: string): string {
    return input.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Same as normalizeFull(), but sorts the whitespace-delimited words
   * alphabetically before rejoining — makes the key order-insensitive.
   * Words (not the finer alpha/digit tokens used by the similarity scorer)
   * are the sort unit here deliberately: sorting inside a word like "Di2"
   * would destroy it, and the fuzzy-matching layer downstream already does
   * its own token-level, order-independent comparison — this key only needs
   * to be stable and collision-resistant for exact/trigram lookups.
   *
   * Lossy by construction: two different trims whose words happen to sort to
   * the same order will collide on this key. Callers that consume this key
   * for exact-match identity (e.g. ProductScrapeUpdaterService's Path 1) must
   * not treat a hit as authoritative when it resolves to more than one
   * distinct ProductModel — see selectPath1Match's multi-model guard.
   */
  private normalizeFullSorted(input: string): string {
    const words = this.normalizeFull(input).split(' ').filter(Boolean);
    return words.sort().join(' ');
  }

  private stripBrandPrefix(source: string, brand: string): string {
    if (!brand) return source.trim();
    const pattern = new RegExp(`^\\s*${this.escapeRegex(brand)}\\b\\s*`, 'i');
    return source.replace(pattern, '').trim();
  }

  private longestAlphaChunk(chunks: string[]): string {
    return chunks.reduce(
      (best, chunk) => (chunk.length > best.length ? chunk : best),
      '',
    );
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private keepAlphanumeric(raw: string): string {
    return raw?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
  }
}
