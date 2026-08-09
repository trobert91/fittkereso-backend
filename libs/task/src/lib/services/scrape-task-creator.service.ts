import { Injectable, NotFoundException } from "@nestjs/common";
import {
  ProductModel,
  ScrapeTask,
  ScrapeTaskRepository,
  ProductSourceRepository,
  ProductModelRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { ScrapeTaskCreateDto } from "../models/scrape-task-create.dto";
import { ScrapeTaskPublisherService } from "./scrape-task-publisher.service";
import { isNil } from "lodash";

@Injectable()
export class ScrapeTaskCreatorService {
  constructor(
    private readonly scrapeTaskRepository: ScrapeTaskRepository,
    private readonly productSourceRepository: ProductSourceRepository,
    private readonly productModelRepository: ProductModelRepository,
    private readonly scrapeTaskPublisherService: ScrapeTaskPublisherService,
  ) {}

  public async create(dto: ScrapeTaskCreateDto): Promise<ScrapeTask> {
    const source = await this.productSourceRepository.findById(dto.sourceId);
    if (isNil(source)) {
      throw new NotFoundException(`Product source not found: ${dto.sourceId}`);
    }

    let product: ProductModel | undefined;
    if (dto.productId) {
      const found = await this.productModelRepository.findById(dto.productId);
      if (isNil(found)) {
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

    return this.scrapeTaskRepository.findOneOrFail({
      where: { id: task.id },
      relations: [
        nameOf<ScrapeTask>("source"),
        nameOf<ScrapeTask>("product"),
        `${nameOf<ScrapeTask>("product")}.${nameOf<ProductModel>("brand")}`,
      ],
    });
  }
}
