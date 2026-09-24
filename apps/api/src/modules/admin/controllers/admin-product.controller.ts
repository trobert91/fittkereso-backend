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
  UseInterceptors,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import {
  AdvisoryLockService,
  MANUAL_IMPORT_TASK_PRIORITY,
  ProductAlias,
  ProductAliasRepository,
  ProductAliasSource,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductImportTaskKind,
  ProductImportTask,
  ProductImportTaskRepository,
  productLock,
  UserRole,
} from '@fittkereso-backend/database';
import {
  ProductDetailService,
  ProductImageDeleteService,
  ProductImageDtoService,
  ProductImageOrderService,
  ProductImageUploadService,
  ProductMergeService,
  ProductUpdateService,
} from '@fittkereso-backend/product';
import { nameOf, SerializeGroup } from '@fittkereso-backend/utils';
import { ProductModelUpdateDto } from '@fittkereso-backend/product';
import { FileInterceptor } from '@nestjs/platform-express';
import { Express } from 'express';
import { ProductSpecUpdateDto } from '@fittkereso-backend/product';
import { ProductSpecUpdaterService } from '@fittkereso-backend/product';
import {
  OfferSearchParams,
  OfferSearchResult,
  OfferSearchService,
  ProductSearchParams,
  ProductSearchResult,
  ProductSearchService,
} from '@fittkereso-backend/search';
import { ProductDuplicateService } from '@fittkereso-backend/product-identity';
import { ProductImportTaskPublisherService } from '@fittkereso-backend/task';
import { QueueStatusDto } from '../dtos/product-source-sync.dto';
import { ProductMergeDto } from '../dtos/product-merge.dto';
import { ResyncProductSourceDto } from '../dtos/resync-product-source.dto';
import { ProductAliasDto } from '../dtos/product-alias.dto';

@Controller('admin-product')
@MinRole(UserRole.admin)
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
    private readonly importTaskPublisher: ProductImportTaskPublisherService,
    private readonly mergeService: ProductMergeService,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly offerSearchService: OfferSearchService,
    private readonly duplicateService: ProductDuplicateService,
    private readonly locks: AdvisoryLockService,
    private readonly importTaskRepo: ProductImportTaskRepository,
  ) {}

  @Post('search')
  @MinRole(UserRole.user)
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async searchProducts(
    @Body() searchParams: ProductSearchParams,
  ): Promise<ProductSearchResult> {
    const result = await this.searchService.searchProducts(searchParams);
    this.imageDtoService.updateProductImageUrls(result.items);
    return result;
  }

  @Get(':id')
  @MinRole(UserRole.user)
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getProduct(@Param('id') id: string) {
    return this.detailService.getProductById(id);
  }

  @Post(':id/offers/search')
  @MinRole(UserRole.user)
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async searchOffersForProduct(
    @Param('id') id: string,
    @Body() searchParams: OfferSearchParams,
  ): Promise<OfferSearchResult> {
    return this.offerSearchService.search({
      ...searchParams,
      productId: id,
    });
  }

  @Put(':id')
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
    // Through the duplicate service, so the survivor is re-detected afterwards
    // exactly as it is when the merge comes from the Duplicates page.
    return this.duplicateService.mergeProducts(sourceId, body.targetProductId);
  }

  // Recomputes this product's specs and name fields (brand/model/
  // displayName/aliases/normalizedName) from its current ProductSourceRecords —
  // the same idempotent recompute every scrape/manual-edit/product-merge
  // already triggers, exposed as a standalone on-demand action.
  @Post(':id/merge-sources')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async mergeProductSources(@Param('id') id: string): Promise<ProductModel> {
    // Under the product's lock, so an import writing to it meanwhile is not
    // overwritten with a copy loaded before.
    await this.locks.withLocks([productLock(id)], async () => {
      const model = await this.productRepo.findOneOrFail({
        where: { id },
        relations: [
          nameOf<ProductModel>('brand'),
          nameOf<ProductModel>('productCategory'),
          nameOf<ProductModel>('sources'),
          `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
        ],
      });

      await this.mergeService.mergeSources(model);
      await this.productRepo.save(model);
    });

    return this.detailService.getProductById(id);
  }

  // ---------------------------------------------------
  // 🏷️ Alias management
  // ---------------------------------------------------

  @Post(':id/aliases')
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

    const task = new ProductImportTask();
    task.kind = ProductImportTaskKind.DetailPage;
    task.source = modelSource.source;
    task.url = modelSource.url;
    task.product = { id: productId } as ProductModel;
    task.force = body.force ?? false;
    task.priority = body.priority ?? MANUAL_IMPORT_TASK_PRIORITY;

    // A feed has no page to fetch: its listing is imported again from the row
    // its last feed run stored.
    if (modelSource.source.type === 'arukereso') {
      const stored = await this.importTaskRepo.latestFeedPayload(
        modelSource.source.id,
        modelSource.url,
      );
      if (!stored) {
        throw new BadRequestException(
          'No feed row is stored for this listing yet — run the source sync to import it.',
        );
      }
      task.kind = ProductImportTaskKind.FeedEntry;
      task.payload = stored.payload;
      task.payloadHash = stored.payloadHash;
    }

    await this.importTaskPublisher.addTask(task);

    return { status: 'queued' };
  }
}
