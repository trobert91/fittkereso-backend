import { Injectable } from '@nestjs/common';
import {
  ProductCategoryRepository,
  ProductSource,
  ProductSourceConfigInvalidError,
  ProductSourceConfigValidatorService,
  ProductSourceRepository,
  QueueName,
  systemActor,
} from '@fittkereso-backend/database';
import { ProductSourceVersionService } from '@fittkereso-backend/product';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSourceImporterRegistry } from '@fittkereso-backend/product-scraper';
import { ProductSourceSyncMessage } from '@fittkereso-backend/task';
import { isEmpty } from 'lodash';
import { In } from 'typeorm';

@Injectable()
export class ProductSourceSyncListener {
  private readonly logger = new CustomLogger(ProductSourceSyncListener.name);

  constructor(
    private readonly sourceRepo: ProductSourceRepository,
    private readonly productCategoryRepo: ProductCategoryRepository,
    private readonly importerRegistry: ProductSourceImporterRegistry,
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
  ) {}

  async process(message: ProductSourceSyncMessage): Promise<any> {
    try {
      this.logger.debug(
        `Processing ProductSourceSync job for source ${message.productSourceId}.`,
      );

      // With its seller: importers key offers by (seller, externalId).
      const entity = await this.sourceRepo.findOneOrFail({
        where: { id: message.productSourceId },
        relations: { seller: true },
      });

      // Before any work is done: a config that cannot be interpreted produces
      // a sync that discovers nothing, or worse, half a catalogue. Failing
      // here means the reason is on the task rather than surfacing later as an
      // empty run.
      await this.assertConfigValid(entity);

      const categorySlugs = await this.resolveCategorySlugs(
        entity,
        message.categoryIds,
      );

      // Deliberately NOT inside a transaction. It used to be, which was
      // harmless while every importer merely enqueued tasks and returned in
      // milliseconds — but a feed importer completes the whole catalogue
      // inline, and wrapping that holds one connection idle-in-transaction for
      // the length of the import. It bought nothing even before: the
      // importer's own writes go through their own repositories on the default
      // connection, so they were never part of that transaction, and
      // `findOneOrFail` takes no row lock despite the comment that used to
      // claim it did. Overlapping runs are prevented where they actually can
      // be — the scheduler advances `nextRunAt` at enqueue time, and its cron
      // waits for the previous tick to finish.
      await this.runImport(entity, categorySlugs);

      entity.lastRunAt = new Date();
      await this.sourceRepo.save(entity);

      this.logger.debug(
        `Finished processing ProductSourceSync job for source ${entity.id}.`,
      );
    } catch (error: unknown) {
      this.logger.error('Error processing ProductSourceSync job: ', error);
      throw error;
    }
  }

  /**
   * Dispatch to the importer for this source's type, and record what it did.
   *
   * The run summary lands on the source's own timeline: it is the run's own
   * trace — what it read, confirmed in place and queued — beside the tasks it
   * queued. A failure is recorded too, then rethrown so the task still fails
   * and retries.
   */
  private async runImport(
    source: ProductSource,
    categorySlugs: string[],
  ): Promise<void> {
    const startedAt = Date.now();
    const importer = this.importerRegistry.get(source.type);

    try {
      const summary = await importer.import(source, { categorySlugs });

      await this.recordRunAction(source, 'import_run_completed', {
        type: source.type,
        ...summary,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      await this.recordRunAction(source, 'import_run_failed', {
        type: source.type,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  /** Audit writes must never mask the outcome they are describing. */
  private async recordRunAction(
    source: ProductSource,
    type: 'import_run_completed' | 'import_run_failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.versionService.recordAction(
        source,
        type,
        payload,
        systemActor('scheduler'),
      );
    } catch (recordError: unknown) {
      this.logger.warn('Failed to record import run action', {
        sourceId: source.id,
        type,
        error:
          recordError instanceof Error
            ? recordError.message
            : String(recordError),
      });
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
    const problems = this.configValidator.problems(source.type, source.config);
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

  /**
   * Which category slugs this run should cover.
   *
   * Gates on `categories.<slug>.enabled`, optionally narrowed to the slugs an
   * operator asked for. Replaces the old sourceTitle lookup, which existed only
   * to feed discovery's category-title matching — startUrls name the listings
   * outright now, so the title is no longer an input to anything.
   */
  private async resolveCategorySlugs(
    source: ProductSource,
    categoryIds: string[] | undefined,
  ): Promise<string[]> {
    const categoriesConfig = source.config.categories ?? {};

    let requested: string[] | undefined;
    if (categoryIds && !isEmpty(categoryIds)) {
      const categories = await this.productCategoryRepo.repo.findBy({
        id: In(categoryIds),
      });
      requested = categories.map((category) => category.slug);

      const missing = categoryIds.length - categories.length;
      if (missing > 0) {
        this.logger.warn(`Import: ${missing} category IDs not found`, {
          categoryIds,
          source: source.name,
        });
      }
    }

    const slugs = Object.entries(categoriesConfig)
      .filter(([slug, cfg]) => cfg.enabled && (!requested || requested.includes(slug)))
      .map(([slug]) => slug);

    if (!isEmpty(requested) && isEmpty(slugs)) {
      this.logger.warn('Import: none of the requested categories are enabled', {
        requested,
        source: source.name,
      });
    }

    return slugs;
  }
}
