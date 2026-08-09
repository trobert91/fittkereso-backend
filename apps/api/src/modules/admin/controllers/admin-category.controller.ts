import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import { ProductCategory, UserRole } from "@ebike-backend/database";
import {
  CategorySearchParams,
  CategoryUpdateDto,
  CategoryWithConfigDto,
  CategoryWithConfigSearchResultDto,
  ProductCategoryDetailService,
  ProductCategoryUpdateService,
} from "@ebike-backend/product";
import { ProductCategorySearchService } from "@ebike-backend/search";
import { SerializeGroup } from "@ebike-backend/utils";
import { CategoryConfigService } from "@ebike-backend/config";

@Controller("admin-category")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminCategoryController {
  constructor(
    private readonly categoryUpdateService: ProductCategoryUpdateService,
    private readonly searchService: ProductCategorySearchService,
    private readonly detailService: ProductCategoryDetailService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  @Get(":id")
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  @Roles([UserRole.admin])
  async getCategory(
    @Param("id") id: string,
    @Query("includeConfig") includeConfig?: string,
  ): Promise<CategoryWithConfigDto> {
    const category = await this.detailService.getById(id);
    return this.wrap(category, includeConfig === "true");
  }

  @Post("search")
  @SerializeOptions({
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  })
  async searchCategories(
    @Body() searchParams: CategorySearchParams,
  ): Promise<CategoryWithConfigSearchResultDto> {
    const result = await this.searchService.search(searchParams);
    const includeConfig = !!searchParams.includeConfig;

    const wrapped = new CategoryWithConfigSearchResultDto();
    wrapped.page = result.page;
    wrapped.pageSize = result.pageSize;
    wrapped.totalItems = result.totalItems;
    wrapped.totalPages = result.totalPages;
    wrapped.sort = result.sort;
    wrapped.order = result.order;
    wrapped.items = (result.items ?? []).map((c) =>
      this.wrap(c, includeConfig),
    );
    return wrapped;
  }

  @Put(":id")
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  @Roles([UserRole.admin])
  async updateCategory(
    @Param("id") id: string,
    @Body() updateDto: CategoryUpdateDto,
    @Query("includeConfig") includeConfig?: string,
  ): Promise<CategoryWithConfigDto> {
    await this.categoryUpdateService.updateCategory(id, updateDto);
    const category = await this.detailService.getById(id);
    return this.wrap(category, includeConfig === "true");
  }

  private wrap(
    category: ProductCategory,
    includeConfig: boolean,
  ): CategoryWithConfigDto {
    const dto = new CategoryWithConfigDto();
    dto.category = category;
    if (includeConfig) {
      dto.config = this.categoryConfigService.getConfig(category.slug);
    }
    return dto;
  }
}
