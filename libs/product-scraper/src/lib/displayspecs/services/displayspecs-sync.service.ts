import { Injectable } from "@nestjs/common";
import {
  ProductSourceSyncService,
  ProductSourceSyncOptions,
} from "../../interfaces/product-source-sync-service.interface";
import {
  BrandRepository,
  ProductSource,
  ScrapeQueueName,
  ScrapeTask,
} from "@ebike-backend/database";
import { DisplaySpecsIndexPageService } from "./displayspecs-index-page.service";
import { CustomLogger } from "@ebike-backend/logger";
import { ProductCollectionMetricsService } from "@ebike-backend/metrics";
import { ScrapeTaskPublisherService } from "@ebike-backend/task";
import { isEmpty } from "lodash";

@Injectable()
export class DisplayspecsSyncService implements ProductSourceSyncService {
  private readonly logger = new CustomLogger(DisplayspecsSyncService.name);

  constructor(
    private readonly brandRepo: BrandRepository,
    private readonly indexService: DisplaySpecsIndexPageService,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async sync(
    source: ProductSource,
    options?: ProductSourceSyncOptions,
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.debug("Starting sync for displayspecs.com");

    try {
      let brandLinks = await this.getBrandLinks(source);

      if (!isEmpty(options?.brandNames)) {
        const allowedNames = new Set(
          (options?.brandNames ?? []).map((name) => name.toLowerCase()),
        );
        const filtered: Record<string, string | null> = {};
        for (const [name, url] of Object.entries(brandLinks)) {
          if (allowedNames.has(name.toLowerCase())) {
            filtered[name] = url;
          }
        }
        brandLinks = filtered;
        this.logger.debug(
          `Filtered to ${Object.keys(brandLinks).length} brands matching: ${(options?.brandNames ?? []).join(", ")}`,
        );
      }

      this.logger.debug(`Product links found: ${JSON.stringify(brandLinks)}`);

      this.productCollectionMetrics.recordCategoriesDiscovered(
        source.type,
        Object.keys(brandLinks).length,
      );

      await this.syncBrands(source, brandLinks);

      this.productCollectionMetrics.fullSyncCompleted(source.type);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.type,
        (Date.now() - startTime) / 1000,
      );
    } catch (error: unknown) {
      this.productCollectionMetrics.fullSyncFailed(source.type);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.type,
        (Date.now() - startTime) / 1000,
      );
      throw error;
    }
  }

  private async getBrandLinks(
    source: ProductSource,
  ): Promise<Record<string, string | null>> {
    const brands = await this.brandRepo.getAll();
    const brandLinks = await this.indexService.fetchBrandLinks(source, brands);
    return brandLinks;
  }

  private async syncBrands(
    source: ProductSource,
    brandLinks: Record<string, string | null>,
  ): Promise<void> {
    const entries = Object.entries(brandLinks);
    this.logger.debug(`Creating tasks for ${entries.length} brands`);

    const validEntries = entries.filter(([_, url]) => !!url);

    const tasks = validEntries.map(([_brandName, url]) => {
      const task = new ScrapeTask();
      task.queue = ScrapeQueueName.ScrapeProductList;
      task.source = source;

      task.url = url!;
      return this.scrapeTaskPublisher.addTask(task);
    });

    await Promise.all(tasks);

    this.productCollectionMetrics.recordListTasksCreated(
      source.type,
      validEntries.length,
    );

    this.logger.debug(`Finished creating tasks for ${entries.length} brands`);
  }
}
