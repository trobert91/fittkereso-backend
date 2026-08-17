import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  SerializeOptions,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import {
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapeQueueName,
  ScrapeTask,
  UserRole,
} from '@fittkereso-backend/database';
import {
  ProductDetailService,
  ProductImageDeleteService,
  ProductImageDtoService,
  ProductImageOrderService,
  ProductImageUploadService,
  ProductMergeService,
  ProductSearchParams,
  ProductSearchResult,
  ProductUpdateService,
} from '@fittkereso-backend/product';
import { nameOf, SerializeGroup } from '@fittkereso-backend/utils';
import { ProductModelUpdateDto } from '@fittkereso-backend/product';
import { FileInterceptor } from '@nestjs/platform-express';
import { Express } from 'express';
import { ProductSpecUpdateDto } from '@fittkereso-backend/product';
import { ProductSpecUpdaterService } from '@fittkereso-backend/product';
import {
  DuplicateSearchParams,
  DuplicateSearchResult,
  ProductDuplicationSearchService,
  ProductSearchService,
} from '@fittkereso-backend/search';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { QueueStatusDto } from '../dtos/product-source-sync.dto';
import { ProductMergeDto } from '../dtos/product-merge.dto';
import { ResyncProductSourceDto } from '../dtos/resync-product-source.dto';
import { ProductAliasDto } from '../dtos/product-alias.dto';

@Controller('admin-product')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminProductController {
  constructor(
    private readonly searchService: ProductSearchService,
    private readonly imageDtoService: ProductImageDtoService,
    private readonly detailService: ProductDetailService,
    private readonly updateService: ProductUpdateService,
    private readonly imageUploadService: ProductImageUploadService,
    private readonly imageOrderService: ProductImageOrderService,
    private readonly imageDeleteService: ProductImageDeleteService,
    private readonly specUpdaterService: ProductSpecUpdaterService,
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly mergeService: ProductMergeService,
    private readonly duplicationSearchService: ProductDuplicationSearchService,
    private readonly aliasRepo: ProductAliasRepository,
  ) {}

  @Post('search')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async searchProducts(
    @Body() searchParams: ProductSearchParams,
  ): Promise<ProductSearchResult> {
    const result = await this.searchService.searchProducts(searchParams);
    this.imageDtoService.updateProductImageUrls(result.items);
    return result;
  }

  @Post('duplicates')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async findDuplicates(
    @Body() params: DuplicateSearchParams,
  ): Promise<DuplicateSearchResult> {
    return this.duplicationSearchService.findDuplicates(params);
  }

  @Get(':id')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  @Roles([UserRole.admin])
  async getProduct(@Param('id') id: string) {
    return this.detailService.getProductById(id);
  }

  @Put(':id')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateProduct(
    @Param('id') id: string,
    @Body() updateDto: ProductModelUpdateDto,
  ) {
    await this.updateService.updateProduct(id, updateDto);

    return this.detailService.getProductById(id);
  }

  @Post(':id/update-manual-specs')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateProductSpecs(
    @Param('id') id: string,
    @Body() updateDto: ProductSpecUpdateDto,
  ) {
    await this.specUpdaterService.updateManualSpecs(id, updateDto.specs);

    return this.detailService.getProductById(id);
  }

  // ---------------------------------------------------
  // 📸 Upload product image
  // ---------------------------------------------------
  @Post(':id/images')
  @Roles([UserRole.admin])
  @UseInterceptors(FileInterceptor('file'))
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async uploadProductImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ProductImage> {
    if (!file) {
      throw new Error('No file uploaded');
    }

    const image = await this.imageUploadService.uploadImage(
      id,
      file.originalname,
      file.buffer,
    );

    this.imageDtoService.updateImageUrls(id, [image]);

    return image;
  }

  // ---------------------------------------------------
  // 🔢 Update image order
  // ---------------------------------------------------
  @Post(':id/image-order')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateImageOrder(
    @Param('id') id: string,
    @Body() newOrder: { id: string; order: number }[],
  ): Promise<ProductModel> {
    await this.imageOrderService.updateImageOrderForId(id, newOrder);

    return this.detailService.getProductById(id);
  }

  @Delete(':id/images/:imageId')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async deleteImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ): Promise<ProductModel> {
    await this.imageDeleteService.deleteImage(id, imageId);

    return this.detailService.getProductById(id);
  }

  @Post(':id/merge')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async mergeProduct(
    @Param('id') sourceId: string,
    @Body() body: ProductMergeDto,
  ): Promise<ProductModel> {
    return this.mergeService.mergeProducts({
      sourceId,
      targetId: body.targetProductId,
    });
  }

  // ---------------------------------------------------
  // 🏷️ Alias management
  // ---------------------------------------------------

  @Post(':id/aliases')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async createAlias(
    @Param('id') id: string,
    @Body() body: ProductAliasDto,
  ): Promise<ProductModel> {
    const alias = new ProductAlias();
    alias.alias = body.alias;
    alias.source = ProductAliasSource.manual;
    alias.model = { id } as ProductModel;
    await this.aliasRepo.save(alias);
    return this.detailService.getProductById(id);
  }

  @Put(':id/aliases/:aliasId')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateAlias(
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
    @Body() body: ProductAliasDto,
  ): Promise<ProductModel> {
    const alias = await this.aliasRepo.findOne({
      where: { id: aliasId },
      relations: [nameOf<ProductAlias>('model')],
    });

    if (!alias || alias.model.id !== id) {
      throw new NotFoundException(
        `Alias ${aliasId} not found for product ${id}`,
      );
    }

    alias.alias = body.alias;
    await this.aliasRepo.save(alias);
    return this.detailService.getProductById(id);
  }

  @Delete(':id/aliases/:aliasId')
  @Roles([UserRole.admin])
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async deleteAlias(
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
  ): Promise<ProductModel> {
    const alias = await this.aliasRepo.findOne({
      where: { id: aliasId },
      relations: [nameOf<ProductAlias>('model')],
    });

    if (!alias || alias.model.id !== id) {
      throw new NotFoundException(
        `Alias ${aliasId} not found for product ${id}`,
      );
    }

    await this.aliasRepo.deleteById(aliasId);
    return this.detailService.getProductById(id);
  }

  @Delete(':id/sources/:sourceId')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async deleteSource(
    @Param('id') id: string,
    @Param('sourceId') sourceId: string,
  ): Promise<ProductModel> {
    const source = await this.sourceRecordRepo.findOne({
      where: { id: sourceId },
      relations: [nameOf<ProductSourceRecord>('model')],
    });

    if (!source || source.model.id !== id) {
      throw new NotFoundException(
        `Source ${sourceId} not found for product ${id}`,
      );
    }

    await this.sourceRecordRepo.deleteById(sourceId);
    return this.detailService.getProductById(id);
  }

  @Post(':id/resync-source')
  async resyncSource(
    @Param('id') productId: string,
    @Body() body: ResyncProductSourceDto,
  ): Promise<QueueStatusDto> {
    const modelSource = await this.sourceRecordRepo.findOne({
      where: { id: body.sourceRecordId },
      relations: [
        nameOf<ProductSourceRecord>('model'),
        nameOf<ProductSourceRecord>('source'),
      ],
    });

    if (!modelSource || modelSource.model.id !== productId) {
      throw new NotFoundException('Product source not found for product');
    }

    if (!modelSource.source) {
      throw new BadRequestException('Manual source cannot be resynced');
    }

    if (!modelSource.url) {
      throw new BadRequestException('Product source url is missing');
    }

    const task = new ScrapeTask();
    task.queue = ScrapeQueueName.ScrapeProductDetails;
    task.source = modelSource.source;
    task.url = modelSource.url;
    task.product = { id: productId } as ProductModel;
    task.force = body.force ?? false;

    await this.scrapeTaskPublisher.addTask(task);

    return { status: 'queued' };
  }
}
