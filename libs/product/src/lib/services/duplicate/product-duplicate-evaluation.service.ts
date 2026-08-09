import { Injectable } from "@nestjs/common";
import {
  ProductAlias,
  ProductAliasSource,
  ProductCategoryRepository,
  ProductDuplicateDecision,
  ProductDuplicateRepository,
  ProductModelRepository,
  ProductReferenceCandidateRepository,
  ProductAliasRepository,
} from "@ebike-backend/database";
import type { SpecMatchDetails } from "@ebike-backend/database";
import { SCHEDULING_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { DuplicateDetectionMetricsService } from "@ebike-backend/metrics";
import { CustomLogger } from "@ebike-backend/logger";
import { ProductDuplicationSearchService } from "@ebike-backend/search";
import { normalize } from "@ebike-backend/utils";
import { isEmpty, isNil } from "lodash";
import { ProductSimilarityService } from "../similarity/product-similarity.service";
import { ProductMergeService } from "../merge/product-merge.service";
import type { DuplicatePairItem } from "@ebike-backend/search";

const MIN_SIMILARITY_FLOOR = 40;
const MIN_REVIEW_COUNT_FOR_HIGH_ACTIVITY = 3;

interface DuplicateDetectionConfig {
  enabled: boolean;
  minSimilarityThreshold: number;
  autoMergeThreshold: number;
  minPendingReviewThreshold: number;
  maxNonPrimaryMismatches: number;
  batchSize: number;
  maxMergesPerRun: number;
  highActivityThreshold: number;
}

interface PairEvaluation {
  decision: ProductDuplicateDecision | "skip";
  reasons: string[];
  specMatchDetails?: SpecMatchDetails;
}

export interface DuplicateDetectionRunSummary {
  categoriesProcessed: number;
  totalPairsEvaluated: number;
  autoMerged: number;
  pendingReview: number;
  skipped: number;
  durationMs: number;
}

@Injectable()
export class ProductDuplicateEvaluationService {
  private readonly logger = new CustomLogger(
    ProductDuplicateEvaluationService.name,
  );

  constructor(
    private readonly duplicationSearchService: ProductDuplicationSearchService,
    private readonly duplicateRepo: ProductDuplicateRepository,
    private readonly mergeService: ProductMergeService,
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly candidateRepo: ProductReferenceCandidateRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly metricsService: DuplicateDetectionMetricsService,
    private readonly productSimilarity: ProductSimilarityService,
  ) {}

  public async processAllCategories(
    categoryId?: string,
  ): Promise<DuplicateDetectionRunSummary> {
    const startTime = Date.now();
    const config = this.resolveConfig();

    let categories;
    if (categoryId) {
      categories = await this.categoryRepo.find({
        where: { id: categoryId, enabled: true },
      });
    } else {
      categories = await this.categoryRepo.find({
        where: { enabled: true, autoDeduplicationEnabled: true },
      });
    }

    const summary: DuplicateDetectionRunSummary = {
      categoriesProcessed: 0,
      totalPairsEvaluated: 0,
      autoMerged: 0,
      pendingReview: 0,
      skipped: 0,
      durationMs: 0,
    };

    let totalMergesThisRun = 0;

    for (const category of categories) {
      const categoryStart = Date.now();

      try {
        const result = await this.processCategory({
          categoryId: category.id,
          categoryName: category.name,
          categorySlug: category.slug ?? undefined,
          config,
          remainingMerges: config.maxMergesPerRun - totalMergesThisRun,
        });

        summary.categoriesProcessed++;
        summary.totalPairsEvaluated += result.evaluated;
        summary.autoMerged += result.autoMerged;
        summary.pendingReview += result.pendingReview;
        summary.skipped += result.skipped;
        totalMergesThisRun += result.autoMerged;

        const durationSeconds = (Date.now() - categoryStart) / 1000;
        this.metricsService.observeDetectionDuration(
          category.name,
          durationSeconds,
        );

        this.logger.log("Category duplicate detection completed", {
          category: category.name,
          evaluated: result.evaluated,
          autoMerged: result.autoMerged,
          pendingReview: result.pendingReview,
          skipped: result.skipped,
          durationSeconds,
        });
      } catch (error: unknown) {
        this.logger.error("Category duplicate detection failed", error, {
          category: category.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.durationMs = Date.now() - startTime;
    return summary;
  }

  public selectMergeTarget(
    pairItemA: { id: string; reviewCount: number; createdAt?: Date },
    pairItemB: { id: string; reviewCount: number; createdAt?: Date },
    referenceCountA: number,
    referenceCountB: number,
  ): { sourceId: string; targetId: string } {
    // Most reviews wins
    if (pairItemA.reviewCount !== pairItemB.reviewCount) {
      return pairItemA.reviewCount > pairItemB.reviewCount
        ? { sourceId: pairItemB.id, targetId: pairItemA.id }
        : { sourceId: pairItemA.id, targetId: pairItemB.id };
    }

    // Tie → most references wins
    if (referenceCountA !== referenceCountB) {
      return referenceCountA > referenceCountB
        ? { sourceId: pairItemB.id, targetId: pairItemA.id }
        : { sourceId: pairItemA.id, targetId: pairItemB.id };
    }

    // Tie → oldest product wins (target)
    const createdAtA = pairItemA.createdAt ?? new Date();
    const createdAtB = pairItemB.createdAt ?? new Date();
    return createdAtA <= createdAtB
      ? { sourceId: pairItemB.id, targetId: pairItemA.id }
      : { sourceId: pairItemA.id, targetId: pairItemB.id };
  }

  private async processCategory(params: {
    categoryId: string;
    categoryName: string;
    categorySlug: string | undefined;
    config: DuplicateDetectionConfig;
    remainingMerges: number;
  }): Promise<{
    evaluated: number;
    autoMerged: number;
    pendingReview: number;
    skipped: number;
  }> {
    const { categoryId, categoryName, categorySlug, config, remainingMerges } =
      params;

    const searchResult = await this.duplicationSearchService.findDuplicates({
      categoryId,
      minSimilarity: config.minSimilarityThreshold,
      pageSize: config.batchSize,
    });

    const pairs = searchResult.items ?? [];
    let evaluated = 0;
    let autoMerged = 0;
    let pendingReview = 0;
    let skipped = 0;
    let mergesRemaining = remainingMerges;

    for (const pair of pairs) {
      evaluated++;
      this.metricsService.pairDetected(categoryName);

      const evaluation = await this.evaluatePair({
        productA: pair.productA,
        productB: pair.productB,
        trigramScore: pair.similarityScore,
        config,
        categorySlug,
      });

      if (evaluation.decision === "skip") {
        skipped++;
        this.metricsService.skipped(
          categoryName,
          evaluation.reasons[0] ?? "unknown",
        );
        continue;
      }

      this.metricsService.observeSimilarityScore(
        categoryName,
        evaluation.decision,
        pair.similarityScore,
      );

      // Record the decision — use in-process score as similarityScore
      const saved = await this.duplicateRepo.upsertPair({
        productAId: pair.productA.id,
        productBId: pair.productB.id,
        decision: evaluation.decision,
        similarityScore: evaluation.inProcessScore ?? pair.similarityScore,
        specMatchDetails: evaluation.specMatchDetails,
        pendingReasons: evaluation.reasons,
      });

      if (!saved) {
        skipped++;
        this.metricsService.skipped(categoryName, "product_not_found");
        continue;
      }

      if (
        evaluation.decision === ProductDuplicateDecision.auto_merged &&
        mergesRemaining > 0
      ) {
        const merged = await this.executeMerge(
          pair.productA,
          pair.productB,
          categoryName,
        );
        if (merged) {
          autoMerged++;
          mergesRemaining--;
          this.metricsService.autoMerged(categoryName);
        }
      } else if (
        evaluation.decision === ProductDuplicateDecision.pending_review
      ) {
        pendingReview++;
        this.metricsService.pendingReview(categoryName);
      }
    }

    return { evaluated, autoMerged, pendingReview, skipped };
  }

  private async evaluatePair(params: {
    productA: DuplicatePairItem;
    productB: DuplicatePairItem;
    trigramScore: number;
    config: DuplicateDetectionConfig;
    categorySlug?: string;
  }): Promise<PairEvaluation & { inProcessScore?: number }> {
    const { productA, productB, trigramScore, config, categorySlug } = params;

    // 1. Check if pair already has a terminal decision
    const existing = await this.duplicateRepo.findExistingPair(
      productA.id,
      productB.id,
    );
    if (existing) {
      const terminalDecisions: ProductDuplicateDecision[] = [
        ProductDuplicateDecision.rejected,
        ProductDuplicateDecision.auto_merged,
        ProductDuplicateDecision.approved,
      ];
      if (terminalDecisions.includes(existing.decision)) {
        return { decision: "skip", reasons: ["already_processed"] };
      }
    }

    // 1b. Trigram similarity floor — too low to even consider
    if (trigramScore < MIN_SIMILARITY_FLOOR) {
      return { decision: "skip", reasons: ["below_similarity_floor"] };
    }

    // 2. Compute in-process similarity score via ProductSimilarityService
    // Query = newer product (later createdAt), candidate = older
    const aIsNewer =
      (productA.createdAt ?? new Date()) >= (productB.createdAt ?? new Date());
    const query = aIsNewer ? productA : productB;
    const candidate = aIsNewer ? productB : productA;

    // Fetch aliases for both products so cross-matching and alias boost work correctly
    const [queryAliases, candidateAliases] = await this.getAliasesForPair(
      query.id,
      candidate.id,
    );

    const similarityResult = this.productSimilarity.score({
      query: {
        model: query.model ?? "",
        displayName: query.displayName,
        aliases: queryAliases,
        specs: query.specs,
      },
      candidate: {
        model: candidate.model ?? "",
        displayName: candidate.displayName,
        aliases: candidateAliases,
        specs: candidate.specs,
        releaseYear: candidate.releaseYear,
      },
      brandName: query.brandName || candidate.brandName,
      categorySlug,
      traceContext: { productId: candidate.id },
    });

    const inProcessScore = similarityResult.score;

    if (inProcessScore < config.minPendingReviewThreshold) {
      return { decision: "skip", reasons: ["below_pending_review_threshold"] };
    }

    const specMatchDetails = similarityResult.specMatchDetails;

    this.logger.debug("Duplicate pair scored", {
      productAId: productA.id,
      productBId: productB.id,
      trigramScore,
      inProcessScore,
      components: similarityResult.components,
      specMatchDetails,
    });

    const belowThreshold = inProcessScore < config.autoMergeThreshold;

    const pendingReasons: string[] = [];

    // 4. Primary spec mismatch
    if (specMatchDetails && specMatchDetails.primaryMismatches > 0) {
      pendingReasons.push(
        `${specMatchDetails.primaryMismatches} primary spec mismatch(es)`,
      );
    }

    // 5. Too many non-primary mismatches
    if (
      specMatchDetails &&
      specMatchDetails.nonPrimaryMismatches > config.maxNonPrimaryMismatches
    ) {
      pendingReasons.push(
        `${specMatchDetails.nonPrimaryMismatches} non-primary mismatches > ${config.maxNonPrimaryMismatches}`,
      );
    }

    // 6. Release year divergence
    if (
      !isNil(productA.releaseYear) &&
      !isNil(productB.releaseYear) &&
      productA.releaseYear !== productB.releaseYear
    ) {
      pendingReasons.push(
        `release year mismatch: ${productA.releaseYear} vs ${productB.releaseYear}`,
      );
    }

    // 7. High activity safety valve
    if (
      productA.reviewCount > MIN_REVIEW_COUNT_FOR_HIGH_ACTIVITY &&
      productB.reviewCount > MIN_REVIEW_COUNT_FOR_HIGH_ACTIVITY
    ) {
      const [refCountA, refCountB] = await this.getReferenceCountsForPair(
        productA.id,
        productB.id,
      );
      if (
        refCountA > config.highActivityThreshold &&
        refCountB > config.highActivityThreshold
      ) {
        pendingReasons.push(
          `high activity: ${refCountA}/${refCountB} refs, ${productA.reviewCount}/${productB.reviewCount} reviews`,
        );
      }
    }

    const needsReview = belowThreshold || !isEmpty(pendingReasons);

    if (needsReview) {
      return {
        decision: ProductDuplicateDecision.pending_review,
        reasons: belowThreshold
          ? [
              `in-process score ${inProcessScore} below threshold ${config.autoMergeThreshold}`,
              ...pendingReasons,
            ]
          : pendingReasons,
        specMatchDetails,
        inProcessScore,
      };
    }

    // All checks pass
    return {
      decision: ProductDuplicateDecision.auto_merged,
      reasons: ["all_checks_passed"],
      specMatchDetails,
      inProcessScore,
    };
  }

  private async executeMerge(
    productA: DuplicatePairItem,
    productB: DuplicatePairItem,
    categoryName: string,
  ): Promise<boolean> {
    try {
      const [refCountA, refCountB] = await this.getReferenceCountsForPair(
        productA.id,
        productB.id,
      );

      const { sourceId, targetId } = this.selectMergeTarget(
        productA,
        productB,
        refCountA,
        refCountB,
      );

      this.logger.log("Auto-merging duplicate pair", {
        sourceId,
        targetId,
        category: categoryName,
        sourceDisplayName:
          sourceId === productA.id
            ? productA.displayName
            : productB.displayName,
        targetDisplayName:
          targetId === productA.id
            ? productA.displayName
            : productB.displayName,
      });

      await this.mergeService.mergeProducts({ sourceId, targetId });

      // Auto-create alias from source model name on the target product
      const source = sourceId === productA.id ? productA : productB;
      const target = targetId === productA.id ? productA : productB;
      await this.maybeAutoCreateAlias(source, target);

      // Update the duplicate record with merge timestamp
      const duplicate = await this.duplicateRepo.findExistingPair(
        productA.id,
        productB.id,
      );
      if (duplicate) {
        duplicate.mergedAt = new Date();
        await this.duplicateRepo.save(duplicate);
      }

      return true;
    } catch (error: unknown) {
      this.logger.error("Auto-merge failed", {
        productAId: productA.id,
        productBId: productB.id,
        category: categoryName,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Auto-create alias from the source product's model name on the target product.
   * Inlined validation guards (numeric overlap) since ProductAliasAutoCreateService
   * lives in libs/product-resolution and can't be imported here.
   */
  private async maybeAutoCreateAlias(
    source: DuplicatePairItem,
    target: DuplicatePairItem,
  ): Promise<void> {
    const sourceModel = source.model;
    if (!sourceModel) return;

    const normalizedAlias = normalize(sourceModel);
    const targetModel = normalize(target.model ?? "");

    if (normalizedAlias.length < 2) return;
    if (normalizedAlias === targetModel) return;

    // Numeric token overlap guard
    const aliasNumbers = normalizedAlias.match(/\d+/g) ?? [];
    const modelNumbers = targetModel.match(/\d+/g) ?? [];
    if (aliasNumbers.length > 0 && modelNumbers.length > 0) {
      const modelNumberSet = new Set(modelNumbers);
      if (!aliasNumbers.some((num) => modelNumberSet.has(num))) return;
    } else if (aliasNumbers.length !== modelNumbers.length) {
      return; // One side has numbers, other doesn't
    }

    try {
      const existing = await this.aliasRepo.findOne({
        where: { alias: normalizedAlias },
      });
      if (existing) return;

      const targetProduct = await this.productRepo.findOne({
        where: { id: target.id },
      });
      if (!targetProduct) return;

      const alias = new ProductAlias();
      alias.alias = normalizedAlias;
      alias.model = targetProduct;
      alias.source = ProductAliasSource.auto_generated;

      await this.aliasRepo.save(alias);

      this.logger.debug("Auto-created alias from dedup merge", {
        alias: normalizedAlias,
        targetId: target.id,
        sourceId: source.id,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message?.includes("unique constraint")
      ) {
        return;
      }
      this.logger.warn("Auto-create alias from dedup failed", {
        alias: normalizedAlias,
        targetId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getAliasesForPair(
    queryId: string,
    candidateId: string,
  ): Promise<[string[], string[]]> {
    const [queryAliasEntities, candidateAliasEntities] = await Promise.all([
      this.aliasRepo.repo.find({ where: { model: { id: queryId } } }),
      this.aliasRepo.repo.find({ where: { model: { id: candidateId } } }),
    ]);

    return [
      queryAliasEntities.map((entity) => entity.alias),
      candidateAliasEntities.map((entity) => entity.alias),
    ];
  }

  private async getReferenceCountsForPair(
    productAId: string,
    productBId: string,
  ): Promise<[number, number]> {
    // Count distinct references with a candidate pointing at each product —
    // the multi-candidate equivalent of "references resolved to this product".
    const countByModel = (modelId: string): Promise<number> =>
      this.candidateRepo.repo
        .createQueryBuilder("candidate")
        .where("candidate.modelId = :modelId", { modelId })
        .select("COUNT(DISTINCT candidate.referenceId)", "count")
        .getRawOne<{ count: string }>()
        .then((row) => Number(row?.count ?? 0));

    const [countA, countB] = await Promise.all([
      countByModel(productAId),
      countByModel(productBId),
    ]);

    return [countA, countB];
  }

  private resolveConfig(): DuplicateDetectionConfig {
    const dynamicConfig =
      this.dynamicConfigService.scheduling?.duplicateDetection;
    const defaults = SCHEDULING_DEFAULTS.duplicateDetection;

    return {
      enabled: dynamicConfig?.enabled ?? defaults.enabled,
      minSimilarityThreshold:
        dynamicConfig?.minSimilarityThreshold ??
        defaults.minSimilarityThreshold,
      autoMergeThreshold:
        dynamicConfig?.autoMergeThreshold ?? defaults.autoMergeThreshold,
      minPendingReviewThreshold:
        dynamicConfig?.minPendingReviewThreshold ??
        defaults.minPendingReviewThreshold,
      maxNonPrimaryMismatches:
        dynamicConfig?.maxNonPrimaryMismatches ??
        defaults.maxNonPrimaryMismatches,
      batchSize: dynamicConfig?.batchSize ?? defaults.batchSize,
      maxMergesPerRun:
        dynamicConfig?.maxMergesPerRun ?? defaults.maxMergesPerRun,
      highActivityThreshold:
        dynamicConfig?.highActivityThreshold ?? defaults.highActivityThreshold,
    };
  }
}
