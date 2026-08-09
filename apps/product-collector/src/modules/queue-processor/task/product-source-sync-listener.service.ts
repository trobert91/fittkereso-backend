import { Injectable } from "@nestjs/common";
import {
  ProductCategoryRepository,
  ProductSource,
  ProductSourceRepository,
  ProductSourceSyncMode,
  ProductSourceType,
} from "@ebike-backend/database";
import { SourceConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ArukeresoSyncService,
  DisplayspecsSyncService,
  IncrementalSyncService,
  ProductSourceSyncService,
} from "@ebike-backend/product-scraper";
import { ProductSourceSyncMessage } from "@ebike-backend/task";
import { isEmpty } from "lodash";
import { In } from "typeorm";

@Injectable()
export class ProductSourceSyncListener {
  private readonly logger = new CustomLogger(ProductSourceSyncListener.name);

  constructor(
    private readonly sourceRepo: ProductSourceRepository,
    private readonly productCategoryRepo: ProductCategoryRepository,
    private readonly sourceConfigService: SourceConfigService,
    private readonly displaySpecsService: DisplayspecsSyncService,
    private readonly arukeresoService: ArukeresoSyncService,
    private readonly incrementalSyncService: IncrementalSyncService,
  ) {}

  async process(message: ProductSourceSyncMessage): Promise<any> {
    try {
      this.logger.debug(
        `Processing ProductSourceSync job for source ${message.productSourceId}.`,
      );

      await this.sourceRepo.repo.manager.transaction(async (transaction) => {
        // Lock the row for update
        const entity = await this.sourceRepo.findOneOrFail(
          {
            where: { id: message.productSourceId },
          },
          transaction,
        );

        if (message.syncMode === ProductSourceSyncMode.incremental) {
          await this.incrementalSyncService.sync(entity);
          entity.lastIncrementalSyncAt = new Date();
        } else {
          const service = this.getSyncService(entity.type);
          const sourceTitles = await this.resolveSourceTitles(
            entity,
            message.categoryIds,
          );
          await service.sync(entity, {
            sourceTitles,
            brandNames: message.brandNames,
          });
          entity.lastFullSyncAt = new Date();
        }

        entity.lastRunAt = new Date();
        await transaction.save(entity);

        this.logger.debug(
          `Finished processing ProductSourceSync job for source ${entity.id}.`,
        );
      });
    } catch (error: unknown) {
      this.logger.error("Error processing ProductSourceSync job: ", error);
      throw error;
    }
  }

  private async resolveSourceTitles(
    source: ProductSource,
    categoryIds: string[] | undefined,
  ): Promise<string[]> {
    let slugs: string[] | undefined;
    if (categoryIds && !isEmpty(categoryIds)) {
      const categories = await this.productCategoryRepo.repo.findBy({
        id: In(categoryIds),
      });
      slugs = categories.map((category) => category.slug);
      const missing = categoryIds.length - categories.length;
      if (missing > 0) {
        this.logger.warn(`Full sync: ${missing} category IDs not found`, {
          categoryIds,
          source: source.type,
        });
      }
    }
    const titles = this.sourceConfigService.getSourceTitles(source.type, slugs);
    if (!isEmpty(slugs) && isEmpty(titles)) {
      this.logger.warn(
        `Full sync: no source titles resolved for requested slugs`,
        { slugs, source: source.type },
      );
    }
    return titles;
  }

  private getSyncService(type: ProductSourceType): ProductSourceSyncService {
    switch (type) {
      case ProductSourceType.arukereso:
        return this.arukeresoService;
      case ProductSourceType.displaySpecs:
        return this.displaySpecsService;

      default:
        throw new Error(`Unknown product source type: ${type}`);
    }
  }
}
