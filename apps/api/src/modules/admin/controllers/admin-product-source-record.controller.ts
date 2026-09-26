import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { MinRole } from '@fittkereso-backend/auth';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  ProductSourceRecordRepository,
  UserRole,
} from '@fittkereso-backend/database';
import {
  ProductSourceRecordSearchParams,
  ProductSourceRecordSearchResult,
  ProductSourceRecordSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { ProductSourceRecordDetailsDto } from '../dtos/product-source-record.dto';

/**
 * Every source's listings (ProductSourceRecord), across sources: on a product
 * or waiting unattached.
 */
@Controller('admin-product-source-record')
@MinRole(UserRole.admin)
export class AdminProductSourceRecordController {
  constructor(
    private readonly searchService: ProductSourceRecordSearchService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  // The rows are plain objects, so the route exposes them whole.
  @Post('search')
  @MinRole(UserRole.user)
  @SerializeOptions({ strategy: 'exposeAll', groups: [SerializeGroup.list] })
  async searchRecords(
    @Body() params: ProductSourceRecordSearchParams,
  ): Promise<ProductSourceRecordSearchResult> {
    return this.searchService.search(params);
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
  async getRecord(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductSourceRecordDetailsDto> {
    const record = await this.sourceRecordRepo.findDetailsById(id);
    if (!record) {
      throw new NotFoundException('Listing not found');
    }

    // The schema lives in the category config, not on the category row.
    const categorySlug =
      record.model?.productCategory?.slug ?? record.scrapedProduct?.category?.slug;

    return Object.assign(new ProductSourceRecordDetailsDto(), {
      record,
      schema: this.categoryConfigService.getJsonSchema(categorySlug) ?? null,
    });
  }
}
