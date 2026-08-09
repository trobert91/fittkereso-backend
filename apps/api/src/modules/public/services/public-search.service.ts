import { Injectable } from "@nestjs/common";
import {
  Brand,
  ProductAlias,
  ProductCategory,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductCategoryRepository,
} from "@ebike-backend/database";
import {
  SearchResultDto,
  SearchProductDto,
  SearchCategoryDto,
} from "../dto/search.dto";
import { ProductImageDtoService } from "@ebike-backend/product";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class PublicSearchService {
  constructor(
    private readonly productModelRepo: ProductModelRepository,
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productImageDtoService: ProductImageDtoService,
  ) {}

  async search(
    q: string,
    page: number,
    pageSize: number,
  ): Promise<SearchResultDto> {
    const trimmed = q.trim();
    if (!trimmed) {
      const empty = new SearchResultDto();
      empty.products = [];
      empty.categories = [];
      empty.total = 0;
      empty.page = page;
      empty.pageSize = pageSize;
      empty.totalPages = 0;
      return empty;
    }

    const offset = (page - 1) * pageSize;

    const [products, categories] = await Promise.all([
      this.searchProducts(trimmed, offset, pageSize),
      page === 1 ? this.searchCategories(trimmed) : Promise.resolve([]),
    ]);

    const result = new SearchResultDto();
    result.products = products.data;
    result.categories = categories;
    result.total = products.total;
    result.page = page;
    result.pageSize = pageSize;
    result.totalPages = Math.ceil(products.total / pageSize);
    return result;
  }

  private async searchProducts(
    q: string,
    offset: number,
    limit: number,
  ): Promise<{ data: SearchProductDto[]; total: number }> {
    const useTrigramSimilarity = q.length >= 3;
    const pattern = `%${q}%`;

    const normalizedNameColumn = `product."${nameOf<ProductModel>("normalizedName")}"`;
    const aliasColumn = `alias.${nameOf<ProductAlias>("alias")}`;
    const displayNameColumn = `product."${nameOf<ProductModel>("displayName")}"`;
    const qb = this.productModelRepo.repo
      .createQueryBuilder("product")
      .leftJoin(`product.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoin(`product.${nameOf<ProductModel>("mainImage")}`, "mainImage")
      .leftJoin(
        `product.${nameOf<ProductModel>("productCategory")}`,
        "category",
      )
      .leftJoin(`product.${nameOf<ProductModel>("aliases")}`, "alias")
      .select([
        `product.${nameOf<ProductModel>("id")}`,
        `product.${nameOf<ProductModel>("slug")}`,
        `product.${nameOf<ProductModel>("displayName")}`,
        `brand.${nameOf<Brand>("name")}`,
        `category.${nameOf<ProductCategory>("slug")}`,
        `mainImage.${nameOf<ProductImage>("url")}`,
        `mainImage.${nameOf<ProductImage>("fileName")}`,
      ])
      .where(`product.${nameOf<ProductModel>("enabled")} = :enabled`, {
        enabled: true,
      });

    if (useTrigramSimilarity) {
      qb.andWhere(
        `(
          ${displayNameColumn} ILIKE :pattern
          OR ${normalizedNameColumn} ILIKE :pattern
          OR ${aliasColumn} ILIKE :pattern
          OR similarity(${normalizedNameColumn}, :q) > 0.1
          OR similarity(${aliasColumn}, :q) > 0.1
        )`,
        { q, pattern },
      )
        .addSelect(
          `GREATEST(
            similarity(${normalizedNameColumn}, :q),
            COALESCE(MAX(similarity(${aliasColumn}, :q)), 0)
          )`,
          "relevance",
        )
        .groupBy(
          `product.${nameOf<ProductModel>("id")}, brand.${nameOf<Brand>("id")}, mainImage.${nameOf<ProductImage>("id")}, category.${nameOf<ProductCategory>("id")}`,
        )
        .orderBy("relevance", "DESC");
    } else {
      qb.andWhere(
        `(${displayNameColumn} ILIKE :pattern OR brand.${nameOf<Brand>("name")} ILIKE :pattern)`,
        { pattern },
      ).orderBy(displayNameColumn, "ASC");
    }

    qb.skip(offset).take(limit);

    const [products, total] = await qb.getManyAndCount();

    this.productImageDtoService.updateProductImageUrls(products);
    const data = products.map((p) => {
      const dto = new SearchProductDto();
      dto.slug = p.slug ?? "";
      dto.displayName = p.displayName;
      dto.brandName = p.brand?.name;
      dto.categorySlug = p.productCategory?.slug ?? undefined;
      dto.mainImageUrl = p.mainImage?.url ?? null;
      return dto;
    });

    return { data, total };
  }

  private async searchCategories(q: string): Promise<SearchCategoryDto[]> {
    const categories = await this.categoryRepo.find({
      where: { enabled: true },
    });

    return categories
      .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 3)
      .map((c) => {
        const dto = new SearchCategoryDto();
        dto.slug = c.slug;
        dto.name = c.name;
        return dto;
      });
  }
}
