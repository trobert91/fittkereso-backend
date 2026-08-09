import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { BasePostgresRepository } from "./base-postgres-repository";
import { ProductCategory } from "../models/product-category.entity";
import { ProductReference } from "../models/product-reference.entity";
import { UserComment } from "../models/user-comment.entity";
import { CommentStatus } from "../types/status-enums";

@Injectable()
export class ProductReferenceRepository extends BasePostgresRepository<ProductReference> {
  constructor(
    @InjectRepository(ProductReference, "postgres")
    repository: Repository<ProductReference>,
  ) {
    super(repository, ProductReference);
  }

  /**
   * Resolution Backfill — Step B: the `limit` highest-priority unresolved refs
   * eligible to be re-resolved now. Eligibility:
   *  - unresolved (no candidates), `enabled`, category resolvable (null or enabled);
   *  - cooldown elapsed (`attemptResolutionAfter` NULL or past) and created within
   *    `maxAgeDays`;
   *  - the ref's comment is heading toward a review: `status IN (APPROVED, IN_REVIEW)`
   *    with `relevance >= minApprovalScore`. `IN_REVIEW` is included because
   *    moderation parks unresolved-high-relevance refs there — exactly what backfill
   *    resolves; the backfill re-moderates the comment after a successful resolve.
   *
   * Priority is highest-relevance first, then longest-waited
   * (`attemptResolutionAfter ASC NULLS FIRST`), then oldest. The sort is served by
   * `ix_product_reference_backfill` (`[relevance, attemptResolutionAfter, createdAt]
   * WHERE enabled`); `comment.status` is indexed and probed per row. Returns refs
   * with comment and productCategory loaded.
   */
  findBackfillCandidates(
    limit: number,
    maxAgeDays: number,
    minApprovalScore: number,
  ): Promise<ProductReference[]> {
    const attemptAfter = `reference.${nameOf<ProductReference>("attemptResolutionAfter")}`;
    return (
      this.repo
        .createQueryBuilder("reference")
        .leftJoinAndSelect(
          `reference.${nameOf<ProductReference>("productCategory")}`,
          "category",
        )
        // INNER: a ref with no comment can never produce a review.
        .innerJoinAndSelect(
          `reference.${nameOf<ProductReference>("comment")}`,
          "comment",
        )
        .where(
          `NOT EXISTS (SELECT 1 FROM product_reference_candidate prc WHERE prc."referenceId" = reference.id)`,
        )
        .andWhere(
          `reference.${nameOf<ProductReference>("enabled")} = :enabled`,
          {
            enabled: true,
          },
        )
        // Category is resolvable: no category constraint, or an enabled category.
        .andWhere(
          `(reference."productCategoryId" IS NULL OR category.${nameOf<ProductCategory>("extractionEnabled")} = true)`,
        )
        // Cooldown elapsed — the backoff is baked into the column at write-time.
        .andWhere(`(${attemptAfter} IS NULL OR ${attemptAfter} <= NOW())`)
        // Age cap — stop retrying references older than the window (abandon stale
        // backlog rather than churning it forever).
        .andWhere(
          `reference.${nameOf<ProductReference>("createdAt")} >= NOW() - make_interval(days => :maxAgeDays)`,
          { maxAgeDays },
        )
        // Review-eligibility: only refs whose comment will be used for review creation.
        .andWhere(
          `comment.${nameOf<UserComment>("status")} IN (:...eligibleStatuses)`,
          {
            eligibleStatuses: [CommentStatus.APPROVED, CommentStatus.IN_REVIEW],
          },
        )
        .andWhere(
          `comment.${nameOf<UserComment>("relevance")} >= :minApprovalScore`,
          { minApprovalScore },
        )
        // Highest relevance first (index-served); longest-waited then oldest break ties.
        .orderBy(`reference.${nameOf<ProductReference>("relevance")}`, "DESC")
        .addOrderBy(attemptAfter, "ASC", "NULLS FIRST")
        .addOrderBy(`reference.${nameOf<ProductReference>("createdAt")}`, "ASC")
        .limit(limit)
        .getMany()
    );
  }

  /**
   * Unresolved references sharing a `productLinkId` group (the same product),
   * excluding the just-resolved reference. Returns refs with comment loaded.
   *
   * `onlyResolvableCategory` controls the category gate by use case:
   *  - propagation (copying candidates onto siblings) passes `true` — a
   *    disabled-category sibling is intentionally held back until its category is
   *    enabled, so it must not be resolved early by a copy;
   *  - evidence pooling (gathering siblings' specs/clues for one resolution)
   *    passes `false` (default) — a disabled-category sibling's identification is
   *    still valid evidence for the same product.
   * No cooldown filter either way, so propagation reaches even long-backed-off
   * siblings now that the product is proven.
   */
  findUnresolvedSiblingsByLinkId(
    productLinkId: string,
    excludeReferenceId: string,
    onlyResolvableCategory = false,
  ): Promise<ProductReference[]> {
    const query = this.repo
      .createQueryBuilder("reference")
      .leftJoinAndSelect(
        `reference.${nameOf<ProductReference>("comment")}`,
        "comment",
      )
      .leftJoinAndSelect(
        `reference.${nameOf<ProductReference>("productCategory")}`,
        "category",
      )
      .where(
        `reference.${nameOf<ProductReference>("productLinkId")} = :productLinkId`,
        { productLinkId },
      )
      .andWhere(`reference.id != :excludeReferenceId`, { excludeReferenceId })
      .andWhere(`reference.${nameOf<ProductReference>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM product_reference_candidate prc WHERE prc."referenceId" = reference.id)`,
      );
    if (onlyResolvableCategory) {
      query.andWhere(
        `(reference."productCategoryId" IS NULL OR category.${nameOf<ProductCategory>("extractionEnabled")} = true)`,
      );
    }
    return query.getMany();
  }
}
