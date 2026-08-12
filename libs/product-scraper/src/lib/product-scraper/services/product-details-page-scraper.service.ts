import { ScrapeTask } from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import * as cheerio from 'cheerio';
import { ProductDetailsPageExtractor } from '../interfaces/product-details-page-extractor.interface';
import { Injectable } from '@nestjs/common';
import { ProductScrapeUpdaterService } from './product-scrape-updater.service';
import { ProductScrapingMetricsService } from '@fittkereso-backend/metrics';

@Injectable()
export class ProductDetailsPageScraperService {
  constructor(
    private readonly scraperService: ScraperService,
    private readonly productUpdaterService: ProductScrapeUpdaterService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
  ) {}

  public async scrapeProductDetailsPage(
    task: ScrapeTask,
    extractor: ProductDetailsPageExtractor,
  ): Promise<void> {
    const sourceType = task.source.type;
    const startTime = Date.now();

    try {
      const html = await this.scraperService.getHtml(task.url);
      const $ = cheerio.load(html);

      const extractionStart = Date.now();
      const scrapedProduct = await extractor.extractProductDetails(task, $);
      this.scrapingMetrics.recordExtractionDuration(
        sourceType,
        (Date.now() - extractionStart) / 1000,
      );

      if (!scrapedProduct) {
        this.scrapingMetrics.recordExtractionOutcome(sourceType, 'skipped');
        return;
      }

      const result = await this.productUpdaterService.createOrUpdateProduct(
        task,
        scrapedProduct,
      );

      if (result) {
        this.scrapingMetrics.recordExtractionOutcome(sourceType, 'success');
      } else {
        this.scrapingMetrics.recordExtractionOutcome(
          sourceType,
          'skipped_brand_failed',
        );
      }
    } catch (error) {
      this.scrapingMetrics.recordExtractionOutcome(sourceType, 'error');
      throw error;
    } finally {
      this.scrapingMetrics.recordScrapeDuration(
        sourceType,
        (Date.now() - startTime) / 1000,
      );
    }
  }
}
