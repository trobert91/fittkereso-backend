import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import {
  ProductSource,
  ProductSourceRepository,
  ProductSourceSyncMode,
  UserRole,
} from '@fittkereso-backend/database';
import { ProductSourceUpdateService } from '@fittkereso-backend/product';
import {
  ProductSourceSearchParams,
  ProductSourceSearchResult,
  ProductSourceSearchService,
} from '@fittkereso-backend/search';
import { QueuePublisherService } from '@fittkereso-backend/task';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { UpdateProductSourceDto } from '../dtos/update-product-source.dto';
import {
  QueueStatusDto,
  TriggerProductSourceFullSyncDto,
} from '../dtos/product-source-sync.dto';

@Controller('admin-product-source')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminProductSourceController {
  constructor(
    private readonly searchService: ProductSourceSearchService,
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly queuePublisher: QueuePublisherService,
    private readonly updateService: ProductSourceUpdateService,
  ) {}

  @Post('search')
  @SerializeOptions({
    strategy: 'exposeAll',
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

  @Get(':id')
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getProductSource(
    @Param('id') productSourceId: string,
  ): Promise<ProductSource> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    return source;
  }

  @Put(':id')
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateProductSource(
    @Param('id') productSourceId: string,
    @Body() updateDto: UpdateProductSourceDto,
  ): Promise<ProductSource> {
    return this.updateService.updateProductSource(productSourceId, updateDto);
  }

  @Post(':id/full-sync')
  async triggerFullSync(
    @Param('id') productSourceId: string,
    @Body() body: TriggerProductSourceFullSyncDto,
  ): Promise<QueueStatusDto> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    await this.queuePublisher.addProductSourceSyncTask({
      productSourceId,
      syncMode: ProductSourceSyncMode.full,
      categoryIds: body?.categoryIds,
      brandNames: body?.brandNames,
    });

    return { status: 'queued' };
  }

  @Post(':id/incremental-sync')
  async triggerIncrementalSync(
    @Param('id') productSourceId: string,
  ): Promise<QueueStatusDto> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    await this.queuePublisher.addProductSourceSyncTask({
      productSourceId,
      syncMode: ProductSourceSyncMode.incremental,
    });

    return { status: 'queued' };
  }
}
