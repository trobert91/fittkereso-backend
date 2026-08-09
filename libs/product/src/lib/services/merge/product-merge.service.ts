import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ProductAlias,
  ProductAliasSource,
  ProductImage,
  ProductModel,
  ProductModelRepository,
  ProductModelSource,
  ProductReferenceCandidate,
  Review,
  ReviewRepository,
  ScrapeTask,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";
import { EntityManager } from "typeorm";
import { isEmpty, keyBy } from "lodash";
import { ProductRatingUpdaterService } from "../rating";
import { ProductSpecUpdaterService } from "../product-spec/product-spec-updater.service";
import { ProductEmbeddingService } from "../product-embedding.service";
import { ProductDetailService } from "../product-detail.service";

const SOFTMAX_TAU = 5;

interface MergeProductsParams {
  sourceId: string;
  targetId: string;
}

@Injectable()
export class ProductMergeService {
  private readonly logger = new CustomLogger(ProductMergeService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly reviewRepo: ReviewRepository,
    private readonly ratingUpdater: ProductRatingUpdaterService,
    private readonly specUpdater: ProductSpecUpdaterService,
    private readonly embeddingService: ProductEmbeddingService,
    private readonly detailService: ProductDetailService,
  ) {}

  public async mergeProducts(
    params: MergeProductsParams,
  ): Promise<ProductModel> {
    const { sourceId, targetId } = params;

    if (sourceId === targetId) {
      throw new BadRequestException(
        "Source and target product cannot be the same",
      );
    }

    await this.productRepo.repo.manager.connection.transaction(
      async (manager) => {
        const source = await this.loadProductForMerge(manager, sourceId);
        const target = await this.loadProductForMerge(manager, targetId);

        if (!source) {
          throw new NotFoundException(`Source product ${sourceId} not found`);
        }
        if (!target) {
          throw new NotFoundException(`Target product ${targetId} not found`);
        }

        this.logger.log("Starting product merge", {
          sourceId,
          targetId,
          sourceDisplayName: source.displayName,
          targetDisplayName: target.displayName,
        });

        await this.mergeReferenceCandidates(manager, sourceId, targetId);
        await this.mergeReviews(manager, source, target);
        await this.moveProductModelSources(manager, source, target);
        await this.moveProductImages(manager, source, target);
        await this.createAliasesFromSource(manager, source, target);
        await this.moveProductAliases(manager, sourceId, targetId);
        await this.moveScrapeTasks(manager, sourceId, targetId);
        await this.deleteSourceProduct(manager, sourceId);

        this.logger.log("Product merge transaction completed", {
          sourceId,
          targetId,
        });
      },
    );

    await this.postMergeUpdates(targetId);

    return this.detailService.getProductById(targetId);
  }

  private async loadProductForMerge(
    manager: EntityManager,
    productId: string,
  ): Promise<ProductModel | null> {
    return manager.findOne(ProductModel, {
      where: { id: productId },
      relations: [
        nameOf<ProductModel>("brand"),
        nameOf<ProductModel>("productCategory"),
        nameOf<ProductModel>("aliases"),
        nameOf<ProductModel>("sources"),
        nameOf<ProductModel>("images"),
        nameOf<ProductModel>("reviews"),
      ],
    });
  }

  /**
   * Migrate every `product_reference_candidate` row from the source product
   * to the target. Three steps:
   *
   *   1. **Dedupe**: drop source-candidate rows on references that already
   *      have a target-candidate row. Without this, the UPDATE in step 2
   *      would violate the `(reference, model)` unique index.
   *   2. **Update**: re-point every remaining source-candidate row at the
   *      target product.
   *   3. **Normalize**: for each affected reference, recompute softmax
   *      weights across the surviving candidates and make sure exactly one
   *      row is marked `isPrimary` (promote the highest-confidence survivor
   *      if dedupe dropped the previous primary).
   */
  private async mergeReferenceCandidates(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    // Identify references that have both source AND target candidates — those
    // are the ones we need to deduplicate.
    const dedupeRows: Array<{ referenceId: string }> = await manager.query(
      `
      SELECT prc."referenceId" AS "referenceId"
      FROM product_reference_candidate prc
      WHERE prc."modelId" = $1
        AND EXISTS (
          SELECT 1 FROM product_reference_candidate prc2
          WHERE prc2."referenceId" = prc."referenceId"
          AND prc2."modelId" = $2
        )
      `,
      [sourceId, targetId],
    );
    const dedupeReferenceIds = dedupeRows.map((row) => row.referenceId);

    if (dedupeReferenceIds.length > 0) {
      await manager.query(
        `
        DELETE FROM product_reference_candidate
        WHERE "modelId" = $1
          AND "referenceId" = ANY($2::uuid[])
        `,
        [sourceId, dedupeReferenceIds],
      );
    }

    // Now collect every reference whose source-candidate row will get updated
    // — that's every remaining row with modelId = source.
    const remainingRows: Array<{ referenceId: string }> = await manager.query(
      `SELECT DISTINCT "referenceId" FROM product_reference_candidate WHERE "modelId" = $1`,
      [sourceId],
    );

    const updateResult = await manager.query(
      `UPDATE product_reference_candidate SET "modelId" = $1 WHERE "modelId" = $2`,
      [targetId, sourceId],
    );

    // Touched references = those whose candidate set just changed (either by
    // dedupe-and-drop OR by source→target update). Recompute weights and
    // the primary marker on each.
    const touchedReferenceIds = new Set<string>([
      ...dedupeReferenceIds,
      ...remainingRows.map((row) => row.referenceId),
    ]);

    for (const referenceId of touchedReferenceIds) {
      await this.normalizeCandidatesForReference(manager, referenceId);
    }

    this.logger.debug("Merged product reference candidates", {
      sourceId,
      targetId,
      deduped: dedupeReferenceIds.length,
      updatedRows: Array.isArray(updateResult)
        ? remainingRows.length
        : remainingRows.length,
      normalizedReferences: touchedReferenceIds.size,
    });
  }

  /**
   * Re-run softmax over a reference's remaining candidates and make sure
   * exactly one row carries `isPrimary = true`. Called per affected reference
   * after a merge dedupe so the partial unique index on `isPrimary` stays
   * satisfied and product-rating aggregation keeps working with sane weights.
   */
  private async normalizeCandidatesForReference(
    manager: EntityManager,
    referenceId: string,
  ): Promise<void> {
    const candidates = await manager.find(ProductReferenceCandidate, {
      where: { reference: { id: referenceId } },
    });

    if (candidates.length === 0) return;

    // Promote the highest-confidence survivor to primary if the merge dropped
    // the previous one. Tie-break on the candidate id so the choice is stable.
    const hasPrimary = candidates.some((candidate) => candidate.isPrimary);
    if (!hasPrimary) {
      const promoted = [...candidates].sort((a, b) => {
        const confidenceDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
        if (confidenceDiff !== 0) return confidenceDiff;
        return a.id.localeCompare(b.id);
      })[0];
      promoted.isPrimary = true;
    }

    // Softmax weight redistribution across the surviving candidates.
    if (candidates.length === 1) {
      candidates[0].weight = 1;
    } else {
      const expScores = candidates.map((candidate) =>
        Math.exp((candidate.confidence ?? 0) / SOFTMAX_TAU),
      );
      const denom = expScores.reduce((sum, value) => sum + value, 0);
      candidates.forEach((candidate, index) => {
        candidate.weight =
          denom > 0 ? expScores[index] / denom : 1 / candidates.length;
      });
    }

    await manager.save(candidates);
  }

  private async mergeReviews(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceReviews = source.reviews ?? [];
    if (isEmpty(sourceReviews)) {
      return;
    }

    const targetReviews = target.reviews ?? [];
    const targetReviewsByUserId = keyBy(targetReviews, "userId");

    const conflictingReviewIds: string[] = [];
    const nonConflictingReviewIds: string[] = [];

    for (const sourceReview of sourceReviews) {
      const targetReview = targetReviewsByUserId[sourceReview.userId];
      if (targetReview) {
        // Move source review's linked candidates to the target review, then
        // delete the source review. The candidate is the source of truth for
        // (review, reference) linkage post-multi-candidate refactor.
        await manager
          .createQueryBuilder()
          .update(ProductReferenceCandidate)
          .set({ review: { id: targetReview.id } })
          .where('"reviewId" = :reviewId', { reviewId: sourceReview.id })
          .execute();

        conflictingReviewIds.push(sourceReview.id);
      } else {
        nonConflictingReviewIds.push(sourceReview.id);
      }
    }

    // Move non-conflicting reviews to target product
    if (!isEmpty(nonConflictingReviewIds)) {
      await manager
        .createQueryBuilder()
        .update(Review)
        .set({ model: { id: target.id } })
        .where("id IN (:...ids)", { ids: nonConflictingReviewIds })
        .execute();
    }

    // Delete conflicting source reviews (references already moved)
    if (!isEmpty(conflictingReviewIds)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(Review)
        .where("id IN (:...ids)", { ids: conflictingReviewIds })
        .execute();
    }

    this.logger.debug("Merged reviews", {
      moved: nonConflictingReviewIds.length,
      conflictsMerged: conflictingReviewIds.length,
    });
  }

  private async moveProductModelSources(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceSources = source.sources ?? [];
    if (isEmpty(sourceSources)) {
      return;
    }

    const targetTypes = new Set((target.sources ?? []).map((s) => s.type));

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const sourceRecord of sourceSources) {
      if (targetTypes.has(sourceRecord.type)) {
        toDelete.push(sourceRecord.id);
      } else {
        toMove.push(sourceRecord.id);
      }
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(ProductModelSource)
        .set({ model: { id: target.id }, deduplicated: true })
        .where("id IN (:...ids)", { ids: toMove })
        .execute();
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(ProductModelSource)
        .where("id IN (:...ids)", { ids: toDelete })
        .execute();
    }

    this.logger.debug("Moved product model sources", {
      moved: toMove.length,
      skipped: toDelete.length,
    });
  }

  private async moveProductImages(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const sourceImages = source.images ?? [];
    if (isEmpty(sourceImages)) {
      return;
    }

    // Clear source's mainImage FK to avoid constraint issues
    await manager
      .createQueryBuilder()
      .update(ProductModel)
      .set({ mainImage: null })
      .where("id = :id", { id: source.id })
      .execute();

    const targetImages = target.images ?? [];
    const maxOrder = isEmpty(targetImages)
      ? 0
      : Math.max(...targetImages.map((img) => img.order)) + 1;

    // Update each source image: move to target and offset order
    for (let i = 0; i < sourceImages.length; i++) {
      await manager
        .createQueryBuilder()
        .update(ProductImage)
        .set({
          model: { id: target.id },
          order: maxOrder + i,
        })
        .where("id = :id", { id: sourceImages[i].id })
        .execute();
    }

    this.logger.debug("Moved product images", {
      count: sourceImages.length,
      startingOrder: maxOrder,
    });
  }

  private async createAliasesFromSource(
    manager: EntityManager,
    source: ProductModel,
    target: ProductModel,
  ): Promise<void> {
    const namesToAlias = [
      source.displayName,
      source.normalizedName,
      source.model,
    ];
    const uniqueNames = [...new Set(namesToAlias)].filter(
      (name) =>
        name && name !== target.displayName && name !== target.normalizedName,
    );

    for (const name of uniqueNames) {
      await this.tryCreateAlias(manager, name, target.id);
    }
  }

  private async tryCreateAlias(
    manager: EntityManager,
    alias: string,
    targetId: string,
  ): Promise<void> {
    try {
      const existing = await manager.findOne(ProductAlias, {
        where: { alias },
      });
      if (existing) {
        return;
      }

      const newAlias = new ProductAlias();
      newAlias.alias = alias;
      newAlias.source = ProductAliasSource.manual;
      newAlias.model = { id: targetId } as ProductModel;
      await manager.save(newAlias);
    } catch (error: unknown) {
      // Unique constraint violation — alias already exists, skip
      this.logger.debug("Skipped duplicate alias", { alias, targetId });
    }
  }

  private async moveProductAliases(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    // Find remaining source aliases (some may have been deleted by CASCADE or already exist on target)
    const sourceAliases = await manager.find(ProductAlias, {
      where: { model: { id: sourceId } },
    });

    if (isEmpty(sourceAliases)) {
      return;
    }

    // Check which alias texts already exist on the target
    const existingTargetAliases = await manager.find(ProductAlias, {
      where: { model: { id: targetId } },
    });
    const existingAliasTexts = new Set(
      existingTargetAliases.map((a) => a.alias),
    );

    const toMove: string[] = [];
    const toDelete: string[] = [];

    for (const alias of sourceAliases) {
      if (existingAliasTexts.has(alias.alias)) {
        toDelete.push(alias.id);
      } else {
        toMove.push(alias.id);
      }
    }

    if (!isEmpty(toDelete)) {
      await manager
        .createQueryBuilder()
        .delete()
        .from(ProductAlias)
        .where("id IN (:...ids)", { ids: toDelete })
        .execute();
    }

    if (!isEmpty(toMove)) {
      await manager
        .createQueryBuilder()
        .update(ProductAlias)
        .set({ model: { id: targetId } })
        .where("id IN (:...ids)", { ids: toMove })
        .execute();
    }

    this.logger.debug("Moved product aliases", {
      moved: toMove.length,
      skipped: toDelete.length,
    });
  }

  private async moveScrapeTasks(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(ScrapeTask)
      .set({ product: { id: targetId } })
      .where('"productId" = :sourceId', { sourceId })
      .execute();

    this.logger.debug("Moved scrape tasks", { count: result.affected });
  }

  private async deleteSourceProduct(
    manager: EntityManager,
    sourceId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .delete()
      .from(ProductModel)
      .where("id = :id", { id: sourceId })
      .execute();

    this.logger.log("Deleted source product", { sourceId });
  }

  private async postMergeUpdates(targetId: string): Promise<void> {
    try {
      // Reload target with all relations needed for post-merge updates
      const target = await this.productRepo.findOneOrFail({
        where: { id: targetId },
        relations: [
          nameOf<ProductModel>("brand"),
          nameOf<ProductModel>("productCategory"),
          nameOf<ProductModel>("sources"),
          nameOf<ProductModel>("reviews"),
          `${nameOf<ProductModel>("reviews")}.${nameOf<Review>("labels")}`,
          nameOf<ProductModel>("rating"),
        ],
      });

      // Re-merge specs from all sources now that sources have been consolidated
      if (!isEmpty(target.sources)) {
        await this.specUpdater.remergeSpecsFromSources(target);
        await this.productRepo.save(target);
      }

      // Recalculate rating
      await this.ratingUpdater.updateProductRating(target);

      // Regenerate embedding
      const embedding = await this.embeddingService.createProductEmbedding({
        brand: target.brand?.name,
        model: target.model,
        displayName: target.displayName,
        category: target.productCategory?.name,
      });

      if (target.embedding) {
        target.embedding.embedding = embedding;
      }
      await this.productRepo.save(target);

      this.logger.log("Post-merge updates completed", { targetId });
    } catch (error: unknown) {
      this.logger.warn("Post-merge updates failed (merge itself succeeded)", {
        targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
