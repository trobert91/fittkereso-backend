import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductCategoryRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { differenceInSeconds } from 'date-fns';

@Injectable()
export class CategoryCacheService {
  private readonly logger = new CustomLogger(CategoryCacheService.name);

  private enabledCache: ProductCategory[] | null = null;
  private enabledLastFetched: number | null = null;

  private allCache: ProductCategory[] | null = null;
  private allLastFetched: number | null = null;

  private readonly CACHE_TTL_SECONDS = 60 * 60; // 1 hour

  constructor(
    private readonly productCategoryRepository: ProductCategoryRepository,
  ) {}

  async getExtractionEnabledCategories(
    useCache = true,
  ): Promise<ProductCategory[]> {
    if (
      useCache &&
      this.isCacheValid(this.enabledCache, this.enabledLastFetched)
    ) {
      return this.enabledCache ?? [];
    }

    const categories = await this.productCategoryRepository.repo.find({
      where: { extractionEnabled: true },
    });

    this.logger.debug(
      `Fetched ${categories.length} extraction-enabled categories.`,
    );

    this.enabledCache = categories;
    this.enabledLastFetched = Date.now();

    return categories;
  }

  async getAllCategories(useCache = true): Promise<ProductCategory[]> {
    if (useCache && this.isCacheValid(this.allCache, this.allLastFetched)) {
      return this.allCache ?? [];
    }

    const categories = await this.productCategoryRepository.repo.find();

    this.logger.debug(`Fetched ${categories.length} total categories.`);

    this.allCache = categories;
    this.allLastFetched = Date.now();

    return categories;
  }

  private isCacheValid(
    cache: ProductCategory[] | null,
    lastFetched: number | null,
  ): boolean {
    if (cache === null || lastFetched === null) {
      return false;
    }

    const elapsedSeconds = differenceInSeconds(Date.now(), lastFetched);
    return elapsedSeconds < this.CACHE_TTL_SECONDS;
  }
}
