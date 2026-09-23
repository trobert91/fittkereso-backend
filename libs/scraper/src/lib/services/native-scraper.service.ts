import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Readable } from 'stream';
import { CustomLogger } from '@fittkereso-backend/logger';
import { NativeScraperMetricsService } from '@fittkereso-backend/metrics';

export interface NativeFetchOptions {
  timeoutMs?: number;
  /**
   * Custom request headers.
   *
   * The reason this exists at all: Zyte's request shape cannot carry them, so
   * anything needing headers — an Inertia JSON endpoint wanting `X-Inertia`, a
   * feed behind a token — has no other route.
   */
  headers?: Record<string, string>;
  /** Bytes. A response exceeding this is abandoned rather than buffered. */
  maxBytes?: number;
}

export interface NativeFetchResult {
  statusCode: number;
  contentType?: string;
  body: string;
}

export interface NativeFetchStream {
  statusCode: number;
  contentType?: string;
  stream: Readable;
}

/** Feeds grow; 26 MB today for one shop. Generous, but not unbounded. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Plain HTTP fetching — no anti-bot proxy, no per-request cost.
 *
 * Lives in libs/scraper beside the Zyte-backed ScraperService so this library
 * stays the only thing that reaches the network for content. The distinction is
 * deliberate and worth keeping visible: Zyte is the paid HTML fetcher for sites
 * that defend against scraping, and it has no business pulling a public feed
 * the shop publishes for exactly this purpose.
 */
@Injectable()
export class NativeScraperService {
  private readonly logger = new CustomLogger(NativeScraperService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly metrics: NativeScraperMetricsService,
  ) {}

  /**
   * Fetch a whole response into memory.
   *
   * For small documents. Anything feed-sized should use `stream` — a 26 MB
   * string is survivable, a DOM built from it is not.
   */
  public async fetch(
    url: string,
    opts: NativeFetchOptions = {},
  ): Promise<NativeFetchResult> {
    const { stream, statusCode, contentType } = await this.stream(url, opts);
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    let size = 0;
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        stream.destroy();
        throw new Error(
          `Response from ${url} exceeded maxBytes (${maxBytes}) — refusing to buffer it`,
        );
      }
      chunks.push(buffer);
    }

    return {
      statusCode,
      contentType,
      body: Buffer.concat(chunks).toString('utf-8'),
    };
  }

  /**
   * Fetch as a stream, so a large document is never materialised whole.
   *
   * A non-2xx throws rather than returning: a 404 or a 500 page parsed as a
   * feed yields zero items, which is indistinguishable from "the shop sells
   * nothing" — and that is exactly the reading that would let a delisting
   * sweep destroy a catalog.
   */
  public async stream(
    url: string,
    opts: NativeFetchOptions = {},
  ): Promise<NativeFetchStream> {
    const startedAt = Date.now();

    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          responseType: 'stream',
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          headers: opts.headers,
          maxRedirects: 5,
          // Non-2xx must reach us as a status, not an axios throw, so the error
          // below can name it.
          validateStatus: () => true,
          decompress: true,
        }),
      );

      const statusCode = response.status;
      const contentType = response.headers?.['content-type'] as
        | string
        | undefined;

      if (statusCode < 200 || statusCode >= 300) {
        (response.data as Readable)?.destroy?.();
        throw new Error(`Fetching ${url} returned HTTP ${statusCode}`);
      }

      // Counted here, at the point the response is accepted — the duration is
      // time to first byte, not time to drain, because the caller streams the
      // body and a 26 MB feed would otherwise measure the consumer.
      this.metrics.fetchCompleted();
      this.metrics.recordFetchDuration((Date.now() - startedAt) / 1000);

      this.logger.debug('Native fetch opened', {
        url,
        statusCode,
        contentType,
        ms: Date.now() - startedAt,
      });

      return { statusCode, contentType, stream: response.data as Readable };
    } catch (error) {
      this.metrics.fetchFailed();
      this.metrics.recordFetchDuration((Date.now() - startedAt) / 1000);
      throw error;
    }
  }
}
