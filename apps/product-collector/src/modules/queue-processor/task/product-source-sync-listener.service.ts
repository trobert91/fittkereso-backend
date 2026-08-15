import { Injectable } from '@nestjs/common';
import {
  ProductCategoryRepository,
  ProductSource,
  ProductSourceRepository,
  ProductSourceSyncMode,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  GenericProductSourceSyncService,
  IncrementalSyncService,
} from '@fittkereso-backend/product-scraper';
import { ProductSourceSyncMessage } from '@fittkereso-backend/task';
import { isEmpty } from 'lodash';
import { In } from 'typeorm';

@Injectable()
export class ProductSourceSyncListener {
  private readonly logger = new CustomLogger(ProductSourceSyncListener.name);

  constructor(
    private readonly sourceRepo: ProductSourceRepository,
    private readonly productCategoryRepo: ProductCategoryRepository,
    private readonly genericSyncService: GenericProductSourceSyncService,
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
          const sourceTitles = await this.resolveSourceTitles(
            entity,
            message.categoryIds,
          );
          await this.genericSyncService.sync(entity, {
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
      this.logger.error('Error processing ProductSourceSync job: ', error);
      throw error;
    }
  }

  private async resolveSourceTitles(
    source: ProductSource,
    categoryIds: string[] | undefined,
  ): Promise<string[]> {
    const categoriesConfig = source.config.categories ?? {};

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
          source: source.name,
        });
      }
    }

    const entries = Object.entries(categoriesConfig).filter(
      ([slug, cfg]) =>
        cfg.enabled && (!slugs || slugs.includes(slug)),
    );
    const titles = entries
      .map(([, cfg]) => cfg.sourceTitle)
      .filter((title): title is string => !!title);

    if (!isEmpty(slugs) && isEmpty(titles)) {
      this.logger.warn(
        `Full sync: no source titles resolved for requested slugs`,
        { slugs, source: source.name },
      );
    }
    return titles;
  }
}
