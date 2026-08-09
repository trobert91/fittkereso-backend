import { Injectable } from "@nestjs/common";
import {
  UserComment,
  UserCommentRepository,
  Thread,
  ThreadProductCategory,
  ProductReference,
  ProductReferenceCandidate,
  ProductModel,
  ProductCategory,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { isEmpty } from "lodash";
import { CommentSearchParams } from "../models/comment-search-params";
import { CommentSearchResult } from "../models/comment-search-result";
import { nameOf } from "@ebike-backend/utils";
import { validate as validateUUID } from "uuid";

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class UserCommentSearchService {
  constructor(private readonly commentRepo: UserCommentRepository) {}

  public async search(
    params: CommentSearchParams,
  ): Promise<CommentSearchResult> {
    const finalParams: CommentSearchParams = {
      ...params,
      searchTerm: params.searchTerm?.trim(),
      threadId: params.threadId?.trim(),
      authorId: params.authorId?.trim(),
      externalId: params.externalId?.trim(),
      parentExternalId: params.parentExternalId?.trim(),
      reviewer: params.reviewer?.trim(),
      categoryIds: params.categoryIds?.map((id) => id.trim()),
      reviewedBy: params.reviewedBy?.map((name) => name.trim()),
      sort: params.sort ?? "createdAt",
      order: params.order ?? "DESC",
    };

    const query = this.buildQuery(finalParams);

    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: CommentSearchParams,
  ): SelectQueryBuilder<UserComment> {
    let query = this.commentRepo.repo
      .createQueryBuilder("comment")
      .leftJoinAndSelect(`comment.${nameOf<UserComment>("thread")}`, "thread")
      .leftJoin(
        `thread.${nameOf<Thread>("categories")}`,
        "threadCategoryJunction",
      )
      .leftJoinAndSelect(
        `threadCategoryJunction.${nameOf<ThreadProductCategory>("productCategory")}`,
        "threadCategory",
      )
      .leftJoinAndSelect(`comment.${nameOf<UserComment>("parent")}`, "parent")
      .leftJoinAndSelect(
        `parent.${nameOf<UserComment>("parent")}`,
        "grandparent",
      )
      .leftJoinAndSelect(
        `grandparent.${nameOf<UserComment>("parent")}`,
        "greatGrandparent",
      )
      .leftJoinAndSelect(
        `comment.${nameOf<UserComment>("productReferences")}`,
        "ref",
      )
      .leftJoinAndSelect(
        `ref.${nameOf<ProductReference>("candidates")}`,
        "candidate",
      )
      .leftJoinAndSelect(
        `candidate.${nameOf<ProductReferenceCandidate>("model")}`,
        "model",
      )
      .leftJoinAndSelect(`model.${nameOf<ProductModel>("brand")}`, "brand")
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("productCategory")}`,
        "modelCategory",
      )
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>("mainImage")}`,
        "modelMainImage",
      )
      .leftJoinAndSelect(
        `candidate.${nameOf<ProductReferenceCandidate>("review")}`,
        "refReview",
      );

    // --- Filters ---
    if (!isEmpty(params.externalId)) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("externalId")} = :externalId`,
        {
          externalId: params.externalId,
        },
      );
    }

    if (!isEmpty(params.parentExternalId)) {
      query = query.andWhere(
        `parent.${nameOf<UserComment>("externalId")} = :parentExternalId`,
        {
          parentExternalId: params.parentExternalId,
        },
      );
    }

    if (!isEmpty(params.reviewedBy)) {
      query = query.andWhere(
        `EXISTS (
          SELECT 1 FROM jsonb_array_elements(comment.${nameOf<UserComment>("moderations")}) m
          WHERE m->>'reviewedBy' = ANY(:reviewedBy)
        )`,
        {
          reviewedBy: params.reviewedBy,
        },
      );
    }

    if (!isEmpty(params.authorId)) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("authorId")} = :authorId`,
        {
          authorId: params.authorId,
        },
      );
    }

    if (!isEmpty(params.threadId)) {
      if (validateUUID(params.threadId)) {
        query = query.andWhere(
          `(thread.${nameOf<Thread>("id")} = :threadUuid OR thread.${nameOf<Thread>("externalId")} = :threadExtId)`,
          {
            threadUuid: params.threadId,
            threadExtId: params.threadId,
          },
        );
      } else {
        query = query.andWhere(
          `thread.${nameOf<Thread>("externalId")} = :threadId`,
          {
            threadId: params.threadId,
          },
        );
      }
    }

    if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `(
          threadCategory.${nameOf<ProductCategory>("id")} IN (:...categoryIds)
          OR modelCategory.${nameOf<ProductCategory>("id")} IN (:...categoryIds)
        )`,
        { categoryIds: params.categoryIds },
      );
    }

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("status")} IN (:...statuses)`,
        {
          statuses: params.statuses,
        },
      );
    }

    if (!isEmpty(params.sentiments)) {
      query = query.andWhere(
        `ref.${nameOf<ProductReference>("sentiment")} IN (:...sentiments)`,
        { sentiments: params.sentiments },
      );
    }

    if (!isEmpty(params.experiences)) {
      query = query.andWhere(
        `ref.${nameOf<ProductReference>("experience")} IN (:...experiences)`,
        { experiences: params.experiences },
      );
    }

    if (!isEmpty(params.depths)) {
      query = query.andWhere(
        `ref.${nameOf<ProductReference>("depth")} IN (:...depths)`,
        { depths: params.depths },
      );
    }

    if (params.reviewer === "Robi") {
      query = query.andWhere(
        `(comment.${nameOf<UserComment>("bucket")} >= 6 OR comment.${nameOf<UserComment>("bucket")} IS NULL)`,
      );
    } else if (params.reviewer === "Ancsi") {
      query = query.andWhere(
        `(comment.${nameOf<UserComment>("bucket")} < 6 OR comment.${nameOf<UserComment>("bucket")} IS NULL)`,
      );
    }

    if (params.minModerationPriority !== undefined) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("moderationPriority")} >= :minModerationPriority`,
        { minModerationPriority: params.minModerationPriority },
      );
    }

    if (params.minOpenIssueSeverity !== undefined) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("openIssueSeverity")} >= :minOpenIssueSeverity`,
        { minOpenIssueSeverity: params.minOpenIssueSeverity },
      );
    }

    if (params.minIssueSeverity !== undefined) {
      query = query.andWhere(
        `comment.${nameOf<UserComment>("issueSeverity")} >= :minIssueSeverity`,
        { minIssueSeverity: params.minIssueSeverity },
      );
    }

    if (params.dateRange && params.dateRange.length === 2) {
      const [startDate, endDate] = params.dateRange;
      if (startDate && endDate) {
        const startOfDay = new Date(startDate);
        startOfDay.setUTCHours(0, 0, 0, 0);

        const endOfDay = new Date(endDate);
        endOfDay.setUTCHours(23, 59, 59, 999);

        query = query.andWhere(
          `comment.${nameOf<UserComment>("createdAt")} >= :startOfDay AND comment.${nameOf<UserComment>("createdAt")} <= :endOfDay`,
          { startOfDay, endOfDay },
        );
      }
    }

    // --- Text search ---
    if (params.searchTerm && !isEmpty(params.searchTerm.trim())) {
      const rawTerm = params.searchTerm.trim().toLowerCase();
      const likeTerm = `%${rawTerm}%`;
      const similarityThreshold = 0.1; // tune as needed

      query = query.andWhere(
        `(
          LOWER(comment.${nameOf<UserComment>("body")}) LIKE :likeTerm
          OR similarity(LOWER(comment.${nameOf<UserComment>("body")}), :rawTerm) >= :similarityThreshold
          OR LOWER(COALESCE(comment.${nameOf<UserComment>("url")}, '')) LIKE :likeTerm
          OR similarity(LOWER(COALESCE(comment.${nameOf<UserComment>("url")}, '')), :rawTerm) >= :similarityThreshold
        )`,
        { likeTerm, rawTerm, similarityThreshold },
      );

      query.addSelect(
        `GREATEST(
          similarity(LOWER(comment.${nameOf<UserComment>("body")}), :rawTerm),
          similarity(LOWER(COALESCE(comment.${nameOf<UserComment>("url")}, '')), :rawTerm)
        )`,
        "similarity_score",
      );

      query = query.orderBy("similarity_score", "DESC");
    } else {
      // --- Ordering ---
      const sort = params.sort ?? "createdAt";
      const order = params.order ?? "DESC";

      query = query.orderBy(`comment.${sort}`, order, "NULLS LAST");
    }

    // --- Pagination ---
    const page: number = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [UserComment[], number],
    params: CommentSearchParams,
  ): CommentSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new CommentSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.categoryIds = params.categoryIds;

    return searchResult;
  }
}
