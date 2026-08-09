import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ProductSource,
  ProductSourceRepository,
  ProductSourceSyncMode,
  UserRole,
} from "@ebike-backend/database";
import {
  ProductSourceSearchParams,
  ProductSourceSearchResult,
  ProductSourceSearchService,
} from "@ebike-backend/search";
import { QueuePublisherService } from "@ebike-backend/task";
import { SerializeGroup } from "@ebike-backend/utils";
import ms from "ms";
import { UpdateProductSourceDto } from "../dtos/update-product-source.dto";
import {
  QueueStatusDto,
  TriggerProductSourceFullSyncDto,
} from "../dtos/product-source-sync.dto";

@Controller("admin-product-source")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminProductSourceController {
  constructor(
    private readonly searchService: ProductSourceSearchService,
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly queuePublisher: QueuePublisherService,
  ) {}

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchProductSources(
    @Body() searchParams: ProductSourceSearchParams,
  ): Promise<ProductSourceSearchResult> {
    return await this.searchService.search(searchParams);
  }

  @Get(":id")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getProductSource(
    @Param("id") productSourceId: string,
  ): Promise<ProductSource> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException("Product source not found");
    }

    return source;
  }

  @Put(":id")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateProductSource(
    @Param("id") productSourceId: string,
    @Body() updateDto: UpdateProductSourceDto,
  ): Promise<ProductSource> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException("Product source not found");
    }

    if (updateDto.name !== undefined) {
      source.name = updateDto.name.trim();
    }

    if (updateDto.schedulingEnabled !== undefined) {
      source.schedulingEnabled = updateDto.schedulingEnabled;
    }

    if (updateDto.processingEnabled !== undefined) {
      source.processingEnabled = updateDto.processingEnabled;
    }

    if (updateDto.priority !== undefined) {
      source.priority = updateDto.priority;
    }

    if (updateDto.maxConcurrent !== undefined) {
      source.maxConcurrent = updateDto.maxConcurrent;
    }

    if (updateDto.requestsPerHour !== undefined) {
      source.requestsPerHour = updateDto.requestsPerHour;
    }

    if (updateDto.fullSyncInterval !== undefined) {
      if (
        updateDto.fullSyncInterval !== null &&
        updateDto.fullSyncInterval.trim() !== ""
      ) {
        const parsedInterval = ms(updateDto.fullSyncInterval as ms.StringValue);

        if (parsedInterval === undefined) {
          throw new BadRequestException("Invalid fullSyncInterval format");
        }

        source.fullSyncInterval = updateDto.fullSyncInterval as ms.StringValue;
      } else {
        source.fullSyncInterval = undefined;
      }
    }

    if (updateDto.incrementalSyncInterval !== undefined) {
      if (
        updateDto.incrementalSyncInterval !== null &&
        updateDto.incrementalSyncInterval.trim() !== ""
      ) {
        const parsedInterval = ms(
          updateDto.incrementalSyncInterval as ms.StringValue,
        );

        if (parsedInterval === undefined) {
          throw new BadRequestException(
            "Invalid incrementalSyncInterval format",
          );
        }

        source.incrementalSyncInterval =
          updateDto.incrementalSyncInterval as ms.StringValue;
      } else {
        source.incrementalSyncInterval = undefined;
      }
    }

    await this.productSourceRepo.save(source);

    return source;
  }

  @Post(":id/full-sync")
  async triggerFullSync(
    @Param("id") productSourceId: string,
    @Body() body: TriggerProductSourceFullSyncDto,
  ): Promise<QueueStatusDto> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException("Product source not found");
    }

    await this.queuePublisher.addProductSourceSyncTask({
      productSourceId,
      syncMode: ProductSourceSyncMode.full,
      categoryIds: body?.categoryIds,
      brandNames: body?.brandNames,
    });

    return { status: "queued" };
  }

  @Post(":id/incremental-sync")
  async triggerIncrementalSync(
    @Param("id") productSourceId: string,
  ): Promise<QueueStatusDto> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException("Product source not found");
    }

    await this.queuePublisher.addProductSourceSyncTask({
      productSourceId,
      syncMode: ProductSourceSyncMode.incremental,
    });

    return { status: "queued" };
  }
}
