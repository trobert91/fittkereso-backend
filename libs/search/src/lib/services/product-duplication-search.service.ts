import { Injectable } from '@nestjs/common';
import { ProductModelRepository } from '@fittkereso-backend/database';
import { plainToInstance } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { DuplicateSearchParams } from '../models/duplicate-search-params';
import {
  DuplicatePair,
  DuplicatePairItem,
  DuplicateSearchResult,
} from '../models/duplicate-search-result';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SIMILARITY_THRESHOLD = 40;

@Injectable()
export class ProductDuplicationSearchService {
  constructor(private readonly productRepo: ProductModelRepository) {}

  public async findDuplicates(
    params: DuplicateSearchParams,
  ): Promise<DuplicateSearchResult> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const threshold =
      (params.minSimilarity ?? DEFAULT_SIMILARITY_THRESHOLD) / 100;
    const offset = (page - 1) * pageSize;

    const queryParams: any[] = [threshold];
    let paramIndex = 2;

    let categoryFilter = '';
    if (params.categoryId) {
      categoryFilter = `AND a."productCategoryId" = $${paramIndex}`;
      queryParams.push(params.categoryId);
      paramIndex++;
    }

    let brandFilter = '';
    if (params.brandId) {
      brandFilter = `AND a."brandId" = $${paramIndex}`;
      queryParams.push(params.brandId);
      paramIndex++;
    }

    const baseQuery = `
      FROM product_model a
      JOIN product_model b
        ON a.id < b.id
        AND a."productCategoryId" = b."productCategoryId"
        AND a."brandId" = b."brandId"
        AND a."brandId" IS NOT NULL
      LEFT JOIN brand ba ON a."brandId" = ba.id
      LEFT JOIN brand bb ON b."brandId" = bb.id
      LEFT JOIN product_category category ON a."productCategoryId" = category.id
      WHERE similarity(a."normalizedName", b."normalizedName") >= $1
        AND NOT EXISTS (
          SELECT 1
          FROM product_model_source sa
          JOIN product_model_source sb
            ON sa.type = sb.type
            AND sa."normalizedSourceName" IS NOT NULL
            AND sb."normalizedSourceName" IS NOT NULL
            AND sa."normalizedSourceName" <> sb."normalizedSourceName"
          WHERE sa."modelId" = a.id
            AND sb."modelId" = b.id
        )
        ${categoryFilter}
        ${brandFilter}
    `;

    const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
    const countResult = await this.productRepo.repo.query(
      countQuery,
      queryParams,
    );
    const totalItems = parseInt(countResult[0]?.count ?? '0', 10);

    const dataQuery = `
      SELECT
        a.id AS "productAId",
        a."displayName" AS "productADisplayName",
        a."normalizedName" AS "productANormalizedName",
        a.model AS "modelA",
        a.specs AS "specsA",
        a."brandId" AS "brandAId",
        a."releaseYear" AS "releaseYearA",
        a."createdAt" AS "createdAtA",
        ba.name AS "brandAName",
        a."orderedSpecs" AS "orderedSpecsA",
        b.id AS "productBId",
        b."displayName" AS "productBDisplayName",
        b."normalizedName" AS "productBNormalizedName",
        b.model AS "modelB",
        b.specs AS "specsB",
        b."brandId" AS "brandBId",
        b."releaseYear" AS "releaseYearB",
        b."createdAt" AS "createdAtB",
        bb.name AS "brandBName",
        b."orderedSpecs" AS "orderedSpecsB",
        similarity(a."normalizedName", b."normalizedName") AS "similarityScore",
        category.name AS "categoryName",
        category.id AS "categoryId"
      ${baseQuery}
      ORDER BY "similarityScore" DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataParams = [...queryParams, pageSize, offset];
    const rows = await this.productRepo.repo.query(dataQuery, dataParams);

    const items: DuplicatePair[] = rows.map((row: any) => {
      const pair = new DuplicatePair();
      const transformOptions = { groups: [SerializeGroup.list] };
      pair.productA = plainToInstance(
        DuplicatePairItem,
        {
          id: row.productAId,
          displayName: row.productADisplayName,
          normalizedName: row.productANormalizedName,
          brandName: row.brandAName ?? '',
          brandId: row.brandAId,
          orderedSpecs: row.orderedSpecsA,
          specs: row.specsA,
          model: row.modelA,
          releaseYear: row.releaseYearA,
          createdAt: row.createdAtA,
        },
        transformOptions,
      );
      pair.productB = plainToInstance(
        DuplicatePairItem,
        {
          id: row.productBId,
          displayName: row.productBDisplayName,
          normalizedName: row.productBNormalizedName,
          brandName: row.brandBName ?? '',
          brandId: row.brandBId,
          orderedSpecs: row.orderedSpecsB,
          specs: row.specsB,
          model: row.modelB,
          releaseYear: row.releaseYearB,
          createdAt: row.createdAtB,
        },
        transformOptions,
      );
      pair.similarityScore = Math.round(parseFloat(row.similarityScore) * 100);
      pair.categoryName = row.categoryName ?? '';
      pair.categoryId = row.categoryId ?? '';
      return pair;
    });

    const result = new DuplicateSearchResult();
    result.items = items;
    result.page = page;
    result.pageSize = pageSize;
    result.totalItems = totalItems;
    result.totalPages = Math.ceil(totalItems / pageSize);

    return result;
  }
}
