import { Injectable } from '@nestjs/common';
import {
  ProductCategoryRepository,
  ProductSource,
  ProductSourceConfigInvalidError,
  ProductSourceConfigValidatorService,
  ProductSourceRepository,
  ProductSourceSyncMode,
  QueueName,
  systemActor,
} from '@fittkereso-backend/database';
import { ProductSourceVersionService } from '@fittkereso-backend/product';
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
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
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

        // Before any work is done, and before either sync mode is chosen: a
        // config that cannot be interpreted produces a sync that discovers
        // nothing, or worse, half a catalogue. Failing here means the reason
        // is on the task rather than surfacing later as an empty run.
        await this.assertConfigValid(entity);

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

  /**
   * Refuses a source whose stored config no longer matches the schema.
   *
   * Checked here even though every save path validates too: a config written
   * before the schema existed, or before an op was renamed, passed the rules
   * of its own day and can still be wrong now. The alternative is discovering
   * it mid-pipeline, after the page fetches have been paid for.
   *
   * The failure is recorded on the source's own timeline as well as on the
   * task, because "this source stopped working" is a question people ask of
   * the source, not of a task list they would have to know to search.
   */
  private async assertConfigValid(source: ProductSource): Promise<void> {
    const problems = this.configValidator.problems(source.config);
    if (!problems) {
      return;
    }

    const error = new ProductSourceConfigInvalidError(source, problems);

    try {
      await this.versionService.recordAction(
        source,
        'config_validation_failed',
        { problems, queue: QueueName.ProductSourceSync },
        systemActor('scheduler'),
      );
    } catch (recordError: unknown) {
      // Never let an audit write turn into a second, misleading failure — the
      // config problem is what the task must report.
      this.logger.warn('Failed to record config validation failure', {
        sourceId: source.id,
        error:
          recordError instanceof Error ? recordError.message : String(recordError),
      });
    }

    throw error;
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
