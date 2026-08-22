import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductModel,
  ScrapeTask,
  ScrapeTaskRepository,
  ProductSourceRepository,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { domainFromUrl, nameOf } from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ScrapeTaskCreateDto } from '../models/scrape-task-create.dto';
import { ScrapeTaskPublisherService } from './scrape-task-publisher.service';
import { isNil } from 'lodash';

@Injectable()
export class ScrapeTaskCreatorService {
  private readonly logger = new CustomLogger(ScrapeTaskCreatorService.name);

  constructor(
    private readonly scrapeTaskRepository: ScrapeTaskRepository,
    private readonly productSourceRepository: ProductSourceRepository,
    private readonly productModelRepository: ProductModelRepository,
    private readonly scrapeTaskPublisherService: ScrapeTaskPublisherService,
  ) {}

  public async create(dto: ScrapeTaskCreateDto): Promise<ScrapeTask> {
    const domain = domainFromUrl(dto.url);
    const source = await this.productSourceRepository.findByDomain(domain);
    if (isNil(source)) {
      this.logger.warn('Cannot create scrape task — no product source matches URL domain', {
        domain,
        queue: dto.queue,
        url: dto.url,
      });
      throw new NotFoundException(`No product source found for domain: ${domain}`);
    }

    let product: ProductModel | undefined;
    if (dto.productId) {
      const found = await this.productModelRepository.findById(dto.productId);
      if (isNil(found)) {
        this.logger.warn('Cannot create scrape task — product not found', {
          productId: dto.productId,
          sourceId: source.id,
        });
        throw new NotFoundException(`Product not found: ${dto.productId}`);
      }
      product = found;
    }

    const task = new ScrapeTask();
    task.queue = dto.queue;
    task.source = source;
    task.url = dto.url;

    if (product) {
      task.product = product;
    }

    if (dto.scheduledAt) {
      task.scheduledAt = new Date(dto.scheduledAt);
    }

    await this.scrapeTaskPublisherService.addTask(task);

    // processingEnabled=false on the source silently blocks the poller's
    // claim query (ScrapeTaskRepository.fetchNextScrapeTask) — surfacing it
    // here means a caller doesn't have to wait for the poller to eventually
    // log the same thing on an idle tick.
    this.logger.log('Scrape task created', {
      taskId: task.id,
      queue: task.queue,
      url: task.url,
      sourceId: source.id,
      sourceName: source.name,
      sourceProcessingEnabled: source.processingEnabled,
      sourceMaxConcurrent: source.maxConcurrent,
      sourceRequestsPerHour: source.requestsPerHour,
      scheduledAt: task.scheduledAt ?? null,
      willBePickedUpImmediately: source.processingEnabled && !task.scheduledAt,
    });

    return this.scrapeTaskRepository.findOneOrFail({
      where: { id: task.id },
      relations: [
        nameOf<ScrapeTask>('source'),
        nameOf<ScrapeTask>('product'),
        `${nameOf<ScrapeTask>('product')}.${nameOf<ProductModel>('brand')}`,
      ],
    });
  }
}
