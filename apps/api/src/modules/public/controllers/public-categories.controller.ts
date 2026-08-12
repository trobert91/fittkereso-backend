import {
  Controller,
  Get,
  Param,
  Query,
  SerializeOptions,
} from '@nestjs/common';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { PublicCategoriesService } from '../services/public-categories.service';
import {
  CategoryListDto,
  CategoryDetailDto,
  FilterConfigDto,
} from '../dto/category.dto';
import { PaginatedProductResult } from '../dto/paginated-result.dto';
import { ProductQueryDto } from '../dto/product-query.dto';

@Controller('v1/public/categories')
@SerializeOptions({ groups: [SerializeGroup.list, SerializeGroup.details] })
export class PublicCategoriesController {
  constructor(private readonly categoriesService: PublicCategoriesService) {}

  @Get()
  async getCategories(): Promise<CategoryListDto[]> {
    return this.categoriesService.getCategories();
  }

  @Get(':slug')
  async getCategoryBySlug(
    @Param('slug') slug: string,
  ): Promise<CategoryDetailDto> {
    return this.categoriesService.getCategoryBySlug(slug);
  }

  @Get(':slug/filter-config')
  async getFilterConfig(
    @Param('slug') slug: string,
    @Query('collectFilters') collectFilters?: string,
  ): Promise<FilterConfigDto> {
    const collect = collectFilters === 'true';
    return this.categoriesService.getFilterConfig(slug, collect);
  }

  @Get(':slug/products')
  async getCategoryProducts(
    @Param('slug') slug: string,
    @Query() query: ProductQueryDto,
  ): Promise<PaginatedProductResult> {
    return this.categoriesService.getCategoryProducts(slug, query);
  }
}
