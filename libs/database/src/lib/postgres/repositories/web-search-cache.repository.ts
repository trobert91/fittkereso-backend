import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import {
  WebSearchCache,
  WebSearchProvider,
  WebSearchResult,
} from '../models/web-search-cache.entity';

export interface WebSearchCacheHit {
  entry: WebSearchCache;
  similarity?: number;
}

@Injectable()
export class WebSearchCacheRepository extends BasePostgresRepository<WebSearchCache> {
  constructor(
    @InjectRepository(WebSearchCache, 'postgres')
    repository: Repository<WebSearchCache>,
  ) {
    super(repository, WebSearchCache);
  }

  /**
   * Find cache hit using keyword similarity and date tolerance
   * @param normalizedKeyword - Normalized search keyword
   * @param searchDate - Target search date (optional)
   * @param similarityThreshold - Min similarity score (0-1, default 0.7)
   * @param dateToleranceDays - Date range window (±days, default 7)
   */
  async findCacheHit(
    normalizedKeyword: string,
    searchDate?: Date,
    similarityThreshold = 0.7,
    dateToleranceDays = 7,
  ): Promise<WebSearchCacheHit | null> {
    const query = this.repo
      .createQueryBuilder('cache')
      .addSelect(`similarity(cache."normalizedKeyword", :keyword)`, 'similarity')
      .where(`similarity(cache."normalizedKeyword", :keyword) > :threshold`)
      .andWhere('cache."expiresAt" > NOW()')
      .setParameter('keyword', normalizedKeyword)
      .setParameter('threshold', similarityThreshold);

    // Add date tolerance filter if searchDate provided
    if (searchDate) {
      const dateMin = new Date(searchDate);
      const dateMax = new Date(searchDate);
      dateMin.setDate(dateMin.getDate() - dateToleranceDays);
      dateMax.setDate(dateMax.getDate() + dateToleranceDays);

      query
        .andWhere(
          '(cache."searchDate" IS NULL OR (cache."searchDate" >= :dateMin AND cache."searchDate" <= :dateMax))',
        )
        .setParameter('dateMin', dateMin)
        .setParameter('dateMax', dateMax);
    }

    // Order by similarity DESC, most recent first
    query.orderBy('similarity', 'DESC').addOrderBy('cache."createdAt"', 'DESC');

    const { entities, raw } = await query.getRawAndEntities();
    const result = entities[0];

    // Update hit metrics if found
    if (result) {
      await this.repo.update({ id: result.id }, {
        hitCount: () => '"hitCount" + 1',
        lastAccessedAt: new Date(),
      } as any);

      const similarityRaw = raw?.[0]?.similarity;
      const similarity =
        similarityRaw != null ? Number(similarityRaw) : undefined;

      return { entry: result, similarity };
    }

    return null;
  }

  /**
   * Store new search results in cache
   */
  async storeCache(
    originalKeyword: string,
    normalizedKeyword: string,
    searchDate: Date | undefined,
    provider: WebSearchProvider,
    results: WebSearchResult[],
    ttlDays = 90,
  ): Promise<WebSearchCache> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    const cache = this.repo.create({
      originalKeyword,
      normalizedKeyword,
      searchDate,
      provider,
      results,
      hitCount: 0,
      lastAccessedAt: new Date(),
      expiresAt,
    });

    return this.repo.save(cache);
  }

  /**
   * Delete expired cache entries (cleanup job)
   */
  async deleteExpired(): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('"expiresAt" <= NOW()')
      .execute();

    return result.affected ?? 0;
  }
}
