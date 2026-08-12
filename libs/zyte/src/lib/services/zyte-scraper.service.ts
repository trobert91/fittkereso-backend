import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { ZyteConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ZyteMetricsService } from '@fittkereso-backend/metrics';

@Injectable()
export class ZyteScraperService {
  private readonly logger = new CustomLogger(ZyteScraperService.name);

  constructor(
    protected httpService: HttpService,
    private zyteConfigService: ZyteConfigService,
    private readonly zyteMetrics: ZyteMetricsService,
  ) {}

  async scrape(url: string): Promise<string> {
    if (!this.zyteConfigService.apiKey) {
      throw new Error('Missing Zyte API Key in environment variables');
    }

    const startTime = Date.now();

    try {
      const payload = {
        url,
        httpResponseBody: true,
        followRedirect: true,
      };

      const auth = {
        username: this.zyteConfigService.apiKey,
        password: '', // Zyte only requires username (API key)
      };

      const response = await firstValueFrom(
        this.httpService.post('/extract', payload, {
          auth,
          baseURL: this.zyteConfigService.apiUrl,
        }),
      );

      // Decode the Base64-encoded HTML body
      const httpResponseBody = Buffer.from(
        response.data.httpResponseBody,
        'base64',
      ).toString('utf-8');

      this.zyteMetrics.scrapeCompleted();
      this.zyteMetrics.recordScrapeDuration((Date.now() - startTime) / 1000);

      return httpResponseBody;
    } catch (error) {
      this.zyteMetrics.scrapeFailed();
      this.zyteMetrics.recordScrapeDuration((Date.now() - startTime) / 1000);

      this.logger.error(
        `Zyte scrape failed for ${url}: ${(error as any).message}`,
        error,
      );
      throw new Error(`Failed to scrape URL: ${url}`);
    }
  }
}
