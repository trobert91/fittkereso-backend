import { Injectable } from '@nestjs/common';
import {
  BrandRepository,
  ProductSource,
  ScrapeQueueName,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { ScraperService } from '@fittkereso-backend/scraper';
import * as cheerio from 'cheerio';
import { isEmpty } from 'lodash';
import {
  ProductSourceSyncOptions,
  ProductSourceSyncService,
} from '../../interfaces/product-source-sync-service.interface';

// Replaces ArukeresoSyncService+ArukeresoIndexPageService+
// DisplayspecsSyncService+DisplaySpecsIndexPageService (four classes) — full
// sync discovery is entirely config-driven now (config.discovery.mode picks
// categoryTitleMatch vs brandNameMatch, both handled by the same
// interpreter), so a single generic service covers every source.
@Injectable()
export class GenericProductSourceSyncService implements ProductSourceSyncService {
  private readonly logger = new CustomLogger(GenericProductSourceSyncService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly brandRepo: BrandRepository,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async sync(
    source: ProductSource,
    options?: ProductSourceSyncOptions,
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.debug(`Starting full sync for source ${source.name}`);

    try {
      const config = source.config;
      if (!config.discovery) {
        this.logger.warn(`No discovery config for source ${source.name}, skipping`);
        this.productCollectionMetrics.recordCategoriesDiscovered(source.name, 0);
        this.productCollectionMetrics.fullSyncCompleted(source.name);
        this.productCollectionMetrics.recordFullSyncDuration(
          source.name,
          (Date.now() - startTime) / 1000,
        );
        return;
      }

      const discoveryUrl = config.fullSyncStartUrl ?? config.baseUrl;
      const html = await this.scraperService.getHtml(discoveryUrl);
      const $ = cheerio.load(html);

      const discoveryOpts =
        config.discovery.mode === 'brandNameMatch'
          ? { brandNames: options?.brandNames ?? (await this.getAllBrandNames()) }
          : { sourceTitles: options?.sourceTitles ?? [] };

      if (
        config.discovery.mode === 'categoryTitleMatch' &&
        isEmpty(discoveryOpts.sourceTitles)
      ) {
        this.logger.warn(
          `Full sync for ${source.name}: no source titles provided, skipping`,
        );
        this.productCollectionMetrics.recordCategoriesDiscovered(source.name, 0);
        this.productCollectionMetrics.fullSyncCompleted(source.name);
        this.productCollectionMetrics.recordFullSyncDuration(
          source.name,
          (Date.now() - startTime) / 1000,
        );
        return;
      }

      const discoveredLinks = await this.interpreter.runDiscovery(
        { id: 'discovery', url: discoveryUrl } as ScrapeTask,
        $,
        config,
        discoveryOpts,
      );

      this.logger.debug(
        `Discovery links found for ${source.name}: ${discoveredLinks.length}`,
      );

      this.productCollectionMetrics.recordCategoriesDiscovered(
        source.name,
        discoveredLinks.length,
      );

      await this.createListTasks(source, discoveredLinks.map((l) => l.url));

      this.productCollectionMetrics.fullSyncCompleted(source.name);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.name,
        (Date.now() - startTime) / 1000,
      );
    } catch (error: unknown) {
      this.productCollectionMetrics.fullSyncFailed(source.name);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.name,
        (Date.now() - startTime) / 1000,
      );
      throw error;
    }
  }

  private async getAllBrandNames(): Promise<string[]> {
    const brands = await this.brandRepo.getAll();
    return brands.map((b) => b.name);
  }

  private async createListTasks(
    source: ProductSource,
    urls: string[],
  ): Promise<void> {
    const validUrls = urls.filter((url) => !isEmpty(url));

    const tasks = validUrls.map((url) => {
      const task = new ScrapeTask();
      task.queue = ScrapeQueueName.ScrapeProductList;
      task.source = source;
      task.url = url;
      return this.scrapeTaskPublisher.addTask(task);
    });

    await Promise.all(tasks);

    this.productCollectionMetrics.recordListTasksCreated(
      source.name,
      validUrls.length,
    );
  }
}
