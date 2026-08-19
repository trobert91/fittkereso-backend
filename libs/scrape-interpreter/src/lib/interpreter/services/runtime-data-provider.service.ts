import { Injectable } from '@nestjs/common';
import { ProductCategory, ProductCategoryRepository } from '@fittkereso-backend/database';
import { BrandCacheService } from '@fittkereso-backend/product';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';

@Injectable()
export class RuntimeDataProviderService implements RuntimeDataProvider {
  // Small in-memory cache mirroring the pattern the old
  // DisplayspecsCategoryMapperService used for repeatedly-looked-up
  // categories — most sources only ever resolve a handful of distinct slugs.
  private readonly categoryCache = new Map<string, ProductCategory | null>();

  constructor(
    private readonly brandCache: BrandCacheService,
    private readonly categoryRepo: ProductCategoryRepository,
  ) {}

  async getBrandNames(): Promise<string[]> {
    const brands = await this.brandCache.getCachedBrands();
    return brands.map((brand) => brand.name);
  }

  async getCategoryBySlug(slug: string): Promise<ProductCategory | null> {
    if (this.categoryCache.has(slug)) {
      return this.categoryCache.get(slug) ?? null;
    }
    const category = await this.categoryRepo.findBySlug(slug);
    this.categoryCache.set(slug, category);
    return category;
  }
}
