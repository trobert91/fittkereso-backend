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
  BrandCreateDto,
  BrandCreateService,
  BrandDetailService,
  BrandUpdateDto,
  BrandUpdateService,
} from '@fittkereso-backend/product';
import {
  BrandSearchParams,
  BrandSearchResult,
  BrandSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Controller('admin-brand')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminBrandController {
  constructor(
    private readonly searchService: BrandSearchService,
    private readonly detailService: BrandDetailService,
    private readonly updateService: BrandUpdateService,
    private readonly createService: BrandCreateService,
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
  async getBrand(@Param('id') id: string) {
    return this.detailService.getById(id);
  }

  @Post('search')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async searchBrands(
    @Body() searchParams: BrandSearchParams,
  ): Promise<BrandSearchResult> {
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
  async createBrand(@Body() createDto: BrandCreateDto) {
    const created = await this.createService.createBrand(createDto);
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
  async updateBrand(
    @Param('id') id: string,
    @Body() updateDto: BrandUpdateDto,
  ) {
    await this.updateService.updateBrand(id, updateDto);
    return this.detailService.getById(id);
  }
}
