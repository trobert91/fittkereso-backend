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
  AutocompleteResultDto,
  AutocompleteProductDto,
  AutocompleteCategoryDto,
} from "../dto/search.dto";
import { ProductImageDtoService } from "@ebike-backend/product";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class PublicAutocompleteService {
  private readonly cache = new Map<
    string,
    { result: AutocompleteResultDto; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 5_000;

  constructor(
    private readonly productModelRepo: ProductModelRepository,
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productImageDtoService: ProductImageDtoService,
  ) {}

  async autocomplete(q: string): Promise<AutocompleteResultDto> {
    const key = q.toLowerCase().trim();
    if (!key) {
      const empty = new AutocompleteResultDto();
      empty.products = [];
      empty.categories = [];
      return empty;
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const [products, categories] = await Promise.all([
      this.searchProducts(key),
      this.searchCategories(key),
    ]);

    const result = new AutocompleteResultDto();
    result.products = products;
    result.categories = categories;

    this.cache.set(key, { result, expiresAt: Date.now() + this.CACHE_TTL_MS });

    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    return result;
  }

  private async searchProducts(q: string): Promise<AutocompleteProductDto[]> {
    const pattern = `%${q}%`;
    const normalizedNameColumn = `product."${nameOf<ProductModel>("normalizedName")}"`;
    const aliasColumn = `alias.${nameOf<ProductAlias>("alias")}`;
    const displayNameColumn = `product."${nameOf<ProductModel>("displayName")}"`;
    const products = await this.productModelRepo.repo
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
      .addSelect(
        `GREATEST(
          similarity(${normalizedNameColumn}, :q),
          COALESCE(MAX(similarity(${aliasColumn}, :q)), 0)
        )`,
        "relevance",
      )
      .where(`product.${nameOf<ProductModel>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `(
          ${displayNameColumn} ILIKE :pattern
          OR ${normalizedNameColumn} ILIKE :pattern
          OR ${aliasColumn} ILIKE :pattern
          OR similarity(${normalizedNameColumn}, :q) > 0.1
          OR similarity(${aliasColumn}, :q) > 0.1
        )`,
        { q, pattern },
      )
      .groupBy(
        `product.${nameOf<ProductModel>("id")}, brand.${nameOf<Brand>("id")}, mainImage.${nameOf<ProductImage>("id")}, category.${nameOf<ProductCategory>("id")}`,
      )
      .orderBy("relevance", "DESC")
      .limit(5)
      .getMany();

    this.productImageDtoService.updateProductImageUrls(products);
    return products
      .filter((p): p is typeof p & { slug: string } => !!p.slug)
      .map((p) => {
        const dto = new AutocompleteProductDto();
        dto.slug = p.slug;
        dto.displayName = p.displayName;
        dto.categorySlug = p.productCategory?.slug ?? undefined;
        dto.brandName = p.brand?.name;
        dto.mainImageUrl = p.mainImage?.url ?? null;
        return dto;
      });
  }

  private async searchCategories(
    q: string,
  ): Promise<AutocompleteCategoryDto[]> {
    const categories = await this.categoryRepo.find({
      where: { enabled: true },
    });

    return categories
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((c) => {
        const dto = new AutocompleteCategoryDto();
        dto.slug = c.slug;
        dto.name = c.name;
        return dto;
      });
  }
}
