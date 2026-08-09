import { Injectable } from "@nestjs/common";
import { Brand, BrandRepository } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { normalize } from "@ebike-backend/utils";
import { differenceInSeconds } from "date-fns";
import { uniq } from "lodash";

@Injectable()
export class BrandCacheService {
  private readonly logger = new CustomLogger(BrandCacheService.name);

  private brandsCache: Brand[] | null = null;
  private brandsLastFetched: number | null = null;
  private termsCache: string[] | null = null;
  private readonly CACHE_TTL_SECONDS = 30 * 60; // 30 minutes

  constructor(private readonly brandRepo: BrandRepository) {}

  public async getCachedBrands(useCache = true): Promise<Brand[]> {
    if (useCache && this.isCacheValid()) {
      return this.brandsCache ?? [];
    }

    const brands = await this.brandRepo.getAll({ order: { name: "ASC" } });

    this.logger.debug(
      `Updating brand cache, fetched ${brands.length} brands from the database.`,
    );

    this.setCache(brands);

    return brands;
  }

  /**
   * Deduplicated, normalised list of brand names and aliases. Suitable for
   * substring matching against normalised text. Built lazily on first access
   * from the cached brand entities and invalidated whenever the brand cache
   * is refreshed.
   */
  public async getCachedBrandTerms(): Promise<string[]> {
    if (this.isCacheValid() && this.termsCache !== null) {
      return this.termsCache;
    }
    const brands = await this.getCachedBrands();
    if (this.termsCache !== null) return this.termsCache;

    const terms = uniq(
      brands.flatMap((brand) => [
        brand.name,
        ...(brand.aliases ?? []).map((alias) => alias.alias),
      ]),
    )
      .filter((term): term is string =>
        Boolean(term && term.trim().length >= 3),
      )
      .map((term) => normalize(term));

    this.termsCache = terms;
    return terms;
  }

  private isCacheValid(): boolean {
    if (this.brandsCache === null || this.brandsLastFetched === null) {
      return false;
    }

    const elapsedSeconds = differenceInSeconds(
      Date.now(),
      this.brandsLastFetched,
    );
    return elapsedSeconds < this.CACHE_TTL_SECONDS;
  }

  private setCache(brands: Brand[]): void {
    this.brandsCache = brands;
    this.brandsLastFetched = Date.now();
    this.termsCache = null;
  }
}
