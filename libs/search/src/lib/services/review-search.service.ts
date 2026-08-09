import { Injectable } from "@nestjs/common";
import {
  Review,
  ReviewRepository,
  ProductModel,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import type { SelectQueryBuilder } from "typeorm";
import { isEmpty } from "lodash";
import { ReviewSearchParams } from "../models/review-search-params";
import { ReviewSearchResult } from "../models/review-search-result";

const DEFAULT_PAGE_SIZE = 40;

@Injectable()
export class ReviewSearchService {
  constructor(private readonly reviewRepo: ReviewRepository) {}

  public async search(params: ReviewSearchParams): Promise<ReviewSearchResult> {
    const finalParams: ReviewSearchParams = {
      ...params,
      searchTerm: params.searchTerm?.trim(),
      userId: params.userId?.trim(),
      productId: params.productId?.trim(),
      productSlug: params.productSlug?.trim(),
      categoryIds: params.categoryIds?.map((id) => id.trim()),
      sort: params.sort ?? "reviewScore",
      order: params.order ?? "DESC",
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  // ─── Query Builder ───

  private buildQuery(params: ReviewSearchParams): SelectQueryBuilder<Review> {
    let query = this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect(`review.${nameOf<Review>("model")}`, "model")
      .leftJoinAndSelect(`model.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("productCategory")}`,
        "modelCategory",
      )
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("mainImage")}`,
        "modelMainImage",
      );

    // --- Soft-delete filter ---
    if (!params.includeDeleted) {
      query = query.andWhere(`review.${nameOf<Review>("deletedAt")} IS NULL`);
    }

    // --- Enabled filter ---
    if (params.enabled !== undefined) {
      query = query.andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: params.enabled,
      });
    }

    // --- Sentiment filter ---
    if (!isEmpty(params.sentiments)) {
      query = query.andWhere(
        `review.${nameOf<Review>("sentiment")} IN (:...sentiments)`,
        { sentiments: params.sentiments },
      );
    }

    // --- Intent filter ---
    if (!isEmpty(params.intents)) {
      query = query.andWhere(
        `review.${nameOf<Review>("intents")} && ARRAY[:...intents]::review_intents_enum[]`,
        { intents: params.intents },
      );
    }

    // --- Experience filter ---
    if (!isEmpty(params.experiences)) {
      query = query.andWhere(
        `review.${nameOf<Review>("experience")} IN (:...experiences)`,
        { experiences: params.experiences },
      );
    }

    // --- Depth filter ---
    if (!isEmpty(params.depths)) {
      query = query.andWhere(
        `review.${nameOf<Review>("depth")} IN (:...depths)`,
        { depths: params.depths },
      );
    }

    // --- Platform filter ---
    if (!isEmpty(params.platforms)) {
      query = query.andWhere(
        `review.${nameOf<Review>("platform")} IN (:...platforms)`,
        { platforms: params.platforms },
      );
    }

    // --- Category filter ---
    if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `modelCategory.${nameOf<ProductModel>("id")} IN (:...categoryIds)`,
        { categoryIds: params.categoryIds },
      );
    }

    // --- Product filter ---
    if (!isEmpty(params.productId)) {
      query = query.andWhere(
        `model.${nameOf<ProductModel>("id")} = :productId`,
        {
          productId: params.productId,
        },
      );
    }

    // --- Product slug filter ---
    if (!isEmpty(params.productSlug)) {
      query = query.andWhere(
        `model.${nameOf<ProductModel>("slug")} = :productSlug`,
        {
          productSlug: params.productSlug,
        },
      );
    }

    // --- User filter ---
    if (!isEmpty(params.userId)) {
      query = query.andWhere(`review.${nameOf<Review>("userId")} = :userId`, {
        userId: params.userId,
      });
    }

    // --- Review score filter ---
    if (params.minReviewScore !== undefined && params.minReviewScore !== null) {
      query = query.andWhere(
        `review.${nameOf<Review>("reviewScore")} >= :minReviewScore`,
        { minReviewScore: params.minReviewScore },
      );
    }

    // --- Date range filter ---
    if (params.dateRange && params.dateRange.length === 2) {
      const [startDate, endDate] = params.dateRange;
      if (startDate) {
        const startOfDay = new Date(startDate);
        startOfDay.setUTCHours(0, 0, 0, 0);
        query = query.andWhere(
          `review."${nameOf<Review>("updatedAt")}" >= :startOfDay`,
          { startOfDay },
        );
      }
      if (endDate) {
        const nextDay = new Date(endDate);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        nextDay.setUTCHours(0, 0, 0, 0);
        query = query.andWhere(
          `review."${nameOf<Review>("updatedAt")}" < :endOfDay`,
          { endOfDay: nextDay },
        );
      }
    }

    // --- Text search ---
    if (params.searchTerm && !isEmpty(params.searchTerm.trim())) {
      const searchPattern = `%${params.searchTerm.trim().toLowerCase()}%`;

      query = query.andWhere(
        `EXISTS (
          SELECT 1 FROM product_reference_candidate prc
          INNER JOIN product_reference pr ON pr.id = prc."referenceId"
          INNER JOIN user_comment uc ON uc.id = pr."commentId"
          LEFT JOIN thread t ON t.id = uc."threadId"
          WHERE prc."reviewId" = review.${nameOf<Review>("id")}
          AND (
            LOWER(uc.body) ILIKE :searchPattern
            OR LOWER(t.title) ILIKE :searchPattern
            OR LOWER(t.topic) ILIKE :searchPattern
          )
        )`,
        { searchPattern },
      );
    }

    // --- Ordering ---
    const sort = params.sort ?? "reviewScore";
    const order = params.order ?? "DESC";

    switch (sort) {
      case "sentiment":
        query.addSelect(
          `CASE review.${nameOf<Review>("sentiment")}
            WHEN 'positive' THEN 4
            WHEN 'neutral' THEN 3
            WHEN 'mixed' THEN 2
            WHEN 'negative' THEN 1
            ELSE 0
          END`,
          "sentiment_order",
        );
        query = query.orderBy("sentiment_order", order, "NULLS LAST");
        break;
      case "experience":
        query.addSelect(
          `CASE review.${nameOf<Review>("experience")}
            WHEN 'owner' THEN 5
            WHEN 'prior_owner' THEN 4
            WHEN 'tested' THEN 3
            WHEN 'prospective_buyer' THEN 2
            WHEN 'reference' THEN 1
            ELSE 0
          END`,
          "experience_order",
        );
        query = query.orderBy("experience_order", order, "NULLS LAST");
        break;
      case "depth":
        query.addSelect(
          `CASE review.${nameOf<Review>("depth")}
            WHEN 'comprehensive' THEN 4
            WHEN 'detailed' THEN 3
            WHEN 'mentioned' THEN 2
            WHEN 'superficial' THEN 1
            ELSE 0
          END`,
          "depth_order",
        );
        query = query.orderBy("depth_order", order, "NULLS LAST");
        break;
      default:
        query = query.orderBy(`review.${sort}`, order, "NULLS LAST");
        break;
    }

    // --- Pagination ---
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  // ─── Result Mapping ───

  private mapToSearchResult(
    result: [Review[], number],
    params: ReviewSearchParams,
  ): ReviewSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ReviewSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;

    return searchResult;
  }
}
