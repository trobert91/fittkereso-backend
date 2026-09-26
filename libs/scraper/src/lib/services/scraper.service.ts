import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { ZyteScraperService } from '@fittkereso-backend/zyte';
import { NativeScraperService } from './native-scraper.service';

/**
 * How a fetch reaches the shop: through the paid scraping API, or from us.
 *
 * ProductSource.fetchMode, restated here so this library needs no database
 * dependency — the two unions are the same values.
 */
export type FetchMode = 'proxied' | 'direct';

/**
 * Zyte's limit on a response body, before base64: "Longer responses are
 * truncated" (Zyte API FAQ), with no error. 10,000,000 is the lower of the two
 * readings of "10 MB", so a cut body is caught either way; a product page is a
 * few hundred KB.
 */
export const PROXIED_MAX_BYTES = 10_000_000;

export interface FetchedStream {
  stream: Readable;
  /** Only a direct fetch knows it; the scraping API does not pass it on. */
  contentType?: string;
}

/**
 * Thrown for a proxied body at the scraping API's size limit: it was
 * truncated, and parsed anyway it would read as a complete, shorter page or
 * feed — for a feed, a catalog with its tail missing.
 */
export class ProxiedResponseTruncatedError extends Error {
  constructor(url: string, bytes: number) {
    super(
      `The scraping API returned ${bytes} bytes for ${url}, its 10 MB limit, so the body was truncated. ` +
        `A document this large can only be fetched directly (fetchMode 'direct').`,
    );
    this.name = 'ProxiedResponseTruncatedError';
  }
}

/**
 * The one way an import reaches a shop's pages and feeds, in the source's
 * fetch mode: 'proxied' goes through Zyte, 'direct' calls the shop itself.
 *
 * The mode is required rather than defaulted, so no caller can end up on
 * either path without having said which.
 */
@Injectable()
export class ScraperService {
  constructor(
    private readonly zyteScraperService: ZyteScraperService,
    private readonly nativeScraper: NativeScraperService,
  ) {}

  public async getHtml(url: string, mode: FetchMode): Promise<string> {
    if (mode === 'direct') {
      return (await this.nativeScraper.fetch(url)).body;
    }

    return this.getProxied(url);
  }

  /**
   * A document as a stream, for feeds. Direct streams it from the shop;
   * proxied has it whole already (the scraping API returns one JSON body), so
   * it is only wrapped.
   */
  public async stream(url: string, mode: FetchMode): Promise<FetchedStream> {
    if (mode === 'direct') {
      const { stream, contentType } = await this.nativeScraper.stream(url);
      return { stream, contentType };
    }

    return { stream: Readable.from([await this.getProxied(url)]) };
  }

  private async getProxied(url: string): Promise<string> {
    const body = await this.zyteScraperService.scrape(url);
    const bytes = Buffer.byteLength(body, 'utf8');

    if (bytes >= PROXIED_MAX_BYTES) {
      throw new ProxiedResponseTruncatedError(url, bytes);
    }

    return body;
  }
}
