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
   * Rule: strip the brand, split on whitespace to preserve word boundaries
   * (so "G5 C34G55TWWP" stays two tokens), and for each whitespace-bounded
   * word that contains a digit, keep all alphanumeric characters (dashes,
   * slashes and other glue characters are dropped, but everything they tie
   * together is preserved). So "34GN850P-B" → "34gn850pb", "39GS95QE-W" →
   * "39gs95qew", "XB271HU-bmiprz" → "xb271hubmiprz". Marketing words
   * (UltraGear, OLED, Pro, Swift, Gaming) are digit-free and fall out.
   */
  public normalizeProduct({
    brand,
    model,
    displayName,
  }: {
    brand: string;
    model: string | undefined;
    displayName: string | undefined;
  }): string {
    const source = model ?? displayName;
    if (!source) {
      throw new Error('Cannot normalize product with unknown name');
    }

    const withoutBrand = this.stripBrandPrefix(source, brand);

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
