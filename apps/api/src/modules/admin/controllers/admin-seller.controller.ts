import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import { UserRole } from '@fittkereso-backend/database';
import {
  SellerCreateDto,
  SellerCreateService,
  SellerDetailService,
  SellerProductSourceCreateDto,
  SellerProductSourceCreateService,
  SellerUpdateDto,
  SellerUpdateService,
} from '@fittkereso-backend/product';
import {
  ProductSourceSearchParams,
  ProductSourceSearchResult,
  ProductSourceSearchService,
  SellerSearchParams,
  SellerSearchResult,
  SellerSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-seller')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminSellerController {
  constructor(
    private readonly searchService: SellerSearchService,
    private readonly detailService: SellerDetailService,
    private readonly updateService: SellerUpdateService,
    private readonly createService: SellerCreateService,
    private readonly productSourceCreateService: SellerProductSourceCreateService,
    private readonly productSourceSearchService: ProductSourceSearchService,
  ) {}

  @Get(':id')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getSeller(@Param('id') id: string) {
    return this.detailService.getById(id);
  }

  @Post('search')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async searchSellers(
    @Body() searchParams: SellerSearchParams,
  ): Promise<SellerSearchResult> {
    return this.searchService.search(searchParams);
  }

  @Post()
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async createSeller(@Body() createDto: SellerCreateDto) {
    const created = await this.createService.createSeller(createDto);
    return this.detailService.getById(created.id);
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
  async updateSeller(
    @Param('id') id: string,
    @Body() updateDto: SellerUpdateDto,
  ) {
    await this.updateService.updateSeller(id, updateDto);
    return this.detailService.getById(id);
  }

  @Post(':id/product-sources')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async createProductSourceForSeller(
    @Param('id') id: string,
    @Body() createDto: SellerProductSourceCreateDto,
  ) {
    await this.productSourceCreateService.createForSeller(id, createDto);
    return this.detailService.getById(id);
  }

  @Post(':id/product-sources/search')
  @SerializeOptions({
    strategy: 'exposeAll',
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchProductSourcesForSeller(
    @Param('id') id: string,
    @Body() searchParams: ProductSourceSearchParams,
  ): Promise<ProductSourceSearchResult> {
    return this.productSourceSearchService.search({
      ...searchParams,
      sellerId: id,
    });
  }
}
