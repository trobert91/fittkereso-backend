import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  MANUAL_IMPORT_TASK_PRIORITY,
  ProductModel,
  ProductSource,
  ProductImportTask,
  ProductImportTaskRepository,
  ProductSourceRepository,
  ProductModelRepository,
  ProductImportTaskKind,
} from '@fittkereso-backend/database';
import { domainFromUrl, nameOf } from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductImportTaskCreateDto } from '../models/product-import-task-create.dto';
import { ProductImportTaskPublisherService } from './product-import-task-publisher.service';
import { isNil } from 'lodash';

@Injectable()
export class ProductImportTaskCreatorService {
  private readonly logger = new CustomLogger(ProductImportTaskCreatorService.name);

  constructor(
    private readonly importTaskRepository: ProductImportTaskRepository,
    private readonly productSourceRepository: ProductSourceRepository,
    private readonly productModelRepository: ProductModelRepository,
    private readonly importTaskPublisherService: ProductImportTaskPublisherService,
  ) {}

  public async create(dto: ProductImportTaskCreateDto): Promise<ProductImportTask> {
    // A feed row's task carries the row itself, which only a feed run has.
    if (dto.kind === ProductImportTaskKind.FeedEntry) {
      throw new BadRequestException(
        'Feed entry tasks are queued by their feed run. To import one feed listing again, resync it from its product.',
      );
    }
    const source = await this.resolveSource(dto);

    let product: ProductModel | undefined;
    if (dto.productId) {
      const found = await this.productModelRepository.findById(dto.productId);
      if (isNil(found)) {
        this.logger.warn('Cannot create import task — product not found', {
          productId: dto.productId,
          sourceId: source.id,
        });
        throw new NotFoundException(`Product not found: ${dto.productId}`);
      }
      product = found;
    }

    const task = new ProductImportTask();
    task.kind = dto.kind;
    task.source = source;
    task.url = dto.url;
    // Created by a person (admin or MCP), so ahead of any run's own tasks.
    task.priority = dto.priority ?? MANUAL_IMPORT_TASK_PRIORITY;

    if (product) {
      task.product = product;
    }

    if (dto.scheduledAt) {
      task.scheduledAt = new Date(dto.scheduledAt);
    }

    await this.importTaskPublisherService.addTask(task);

    // processingEnabled=false on the source silently keeps the scheduler's
    // claim (ProductImportTaskRepository.claimBatch) off this task — surfacing
    // it here means a caller doesn't have to wonder why it never starts.
    this.logger.log('Import task created', {
      taskId: task.id,
      kind: task.kind,
      priority: task.priority,
      url: task.url,
      sourceId: source.id,
      sourceName: source.name,
      sourceProcessingEnabled: source.processingEnabled,
      sourceMaxConcurrent: source.maxConcurrent,
      sourceRequestsPerHour: source.requestsPerHour,
      scheduledAt: task.scheduledAt ?? null,
      willBePickedUpImmediately: source.processingEnabled && !task.scheduledAt,
    });

    return this.importTaskRepository.findOneOrFail({
      where: { id: task.id },
      relations: [
        nameOf<ProductImportTask>('source'),
        nameOf<ProductImportTask>('product'),
        `${nameOf<ProductImportTask>('product')}.${nameOf<ProductModel>('brand')}`,
      ],
    });
  }

  /**
   * Which source this task belongs to.
   *
   * An explicit `productSourceId` wins, and it is the only reliable answer now
   * that one webshop can have several sources: resolving from the URL's domain
   * alone used to take whichever row the database happened to return first,
   * which is a silent wrong answer rather than an error.
   *
   * Without one, the domain still resolves — but only when it is unambiguous
   * among the sources an import task can actually belong to.
   */
  private async resolveSource(dto: ProductImportTaskCreateDto): Promise<ProductSource> {
    if (dto.productSourceId) {
      const source = await this.productSourceRepository.findOne({
        where: { id: dto.productSourceId },
      });
      if (isNil(source)) {
        throw new NotFoundException(
          `Product source not found: ${dto.productSourceId}`,
        );
      }
      this.assertScrapable(source);
      return source;
    }

    const domain = domainFromUrl(dto.url);
    const all = await this.productSourceRepository.findAllByDomain(domain);

    // A ProductImportTask fetches and parses a page, which only a scraping source
    // knows how to do — a feed source has no page pipelines at all, and a task
    // pointed at one fails later, in a worker, with a config-narrowing error.
    const candidates = all.filter((source) => source.type === 'scraping');

    if (candidates.length === 0) {
      this.logger.warn(
        'Cannot create import task — no scraping product source matches URL domain',
        { domain, kind: dto.kind, url: dto.url, sourcesOnDomain: all.length },
      );
      throw new NotFoundException(
        all.length === 0
          ? `No product source found for domain: ${domain}`
          : `No SCRAPING product source for domain ${domain} — it has ${all.length} source(s), none of which scrape pages.`,
      );
    }

    if (candidates.length > 1) {
      throw new BadRequestException(
        `Domain ${domain} has ${candidates.length} scraping product sources ` +
          `(${candidates.map((source) => `${source.name} [${source.id}]`).join(', ')}). ` +
          `Pass productSourceId to say which one this task belongs to.`,
      );
    }

    return candidates[0];
  }

  private assertScrapable(source: ProductSource): void {
    if (source.type !== 'scraping') {
      throw new BadRequestException(
        `Product source "${source.name}" is of type "${source.type}", which imports a feed rather than ` +
          `scraping pages — it has no page pipelines, so an import task for it could never run. ` +
          `Use simulate_product_source_import or a full sync to exercise it instead.`,
      );
    }
  }
}
