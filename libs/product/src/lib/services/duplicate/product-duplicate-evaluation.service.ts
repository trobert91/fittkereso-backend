import { Injectable } from '@nestjs/common';
import {
  ProductCategoryRepository,
  ProductResolutionFlow,
  ProductResolutionOrigin,
  ProductResolutionRepository,
  ProductResolutionStatus,
  ProductModelRepository,
  ProductAliasRepository,
} from '@fittkereso-backend/database';
import type {
  SpecMatchDetails,
  ProductResolutionCandidateRecord,
  ProductDuplicateDetectionInputSnapshot,
} from '@fittkereso-backend/database';
import { SCHEDULING_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { DuplicateDetectionMetricsService } from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductDuplicationSearchService } from '@fittkereso-backend/search';
import { normalize } from '@fittkereso-backend/utils';
import { isEmpty, isNil } from 'lodash';
import { ProductSimilarityService } from '../similarity/product-similarity.service';
import { ProductMergeService } from '../merge/product-merge.service';
import { ProductResolutionRecorderService } from '../resolution/product-resolution-recorder.service';
import {
  selectMergeTarget,
  type MergeTargetCandidate,
} from './select-merge-target';
import type { DuplicatePairItem } from '@fittkereso-backend/search';

const MIN_SIMILARITY_FLOOR = 40;

interface DuplicateDetectionConfig {
  enabled: boolean;
  minSimilarityThreshold: number;
  autoMergeThreshold: number;
  minPendingReviewThreshold: number;
  maxNonPrimaryMismatches: number;
  batchSize: number;
}

interface PairEvaluation {
  /** Whether this pair is worth putting in front of a reviewer at all. */
  outcome: 'record' | 'skip';
  /** True when the pair cleared every check — the system would have merged it
   *  automatically under the old behavior. It no longer does; this is now only
   *  a confidence signal for the reviewer and the metrics label. */
  confident: boolean;
  reasons: string[];
  specMatchDetails?: SpecMatchDetails;
  candidates?: ProductResolutionCandidateRecord[];
  inputSnapshot?: ProductDuplicateDetectionInputSnapshot;
}

export interface DuplicateDetectionRunSummary {
  categoriesProcessed: number;
  totalPairsEvaluated: number;
  /** Pairs written to the review queue. Detection never merges — every merge
   *  goes through a human accepting the row. */
  recorded: number;
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
    private readonly duplicateRepo: ProductResolutionRepository,
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly metricsService: DuplicateDetectionMetricsService,
    private readonly productSimilarity: ProductSimilarityService,
    private readonly resolutionRecorder: ProductResolutionRecorderService,
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
        where: { enabled: true },
      });
    }

    const summary: DuplicateDetectionRunSummary = {
      categoriesProcessed: 0,
      totalPairsEvaluated: 0,
      recorded: 0,
      skipped: 0,
      durationMs: 0,
    };

    for (const category of categories) {
      const categoryStart = Date.now();

      try {
        const result = await this.processCategory({
          categoryId: category.id,
          categoryName: category.name,
          categorySlug: category.slug ?? undefined,
          config,
        });

        summary.categoriesProcessed++;
        summary.totalPairsEvaluated += result.evaluated;
        summary.recorded += result.recorded;
        summary.skipped += result.skipped;

        const durationSeconds = (Date.now() - categoryStart) / 1000;
        this.metricsService.observeDetectionDuration(
          category.name,
          durationSeconds,
        );

        this.logger.log('Category duplicate detection completed', {
          category: category.name,
          evaluated: result.evaluated,
          recorded: result.recorded,
          skipped: result.skipped,
          durationSeconds,
        });
      } catch (error: unknown) {
        this.logger.error('Category duplicate detection failed', error, {
          category: category.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.durationMs = Date.now() - startTime;
    return summary;
  }

  public selectMergeTarget(
    pairItemA: MergeTargetCandidate,
    pairItemB: MergeTargetCandidate,
  ): { sourceId: string; targetId: string } {
    return selectMergeTarget(pairItemA, pairItemB);
  }

  private async processCategory(params: {
    categoryId: string;
    categoryName: string;
    categorySlug: string | undefined;
    config: DuplicateDetectionConfig;
  }): Promise<{
    evaluated: number;
    recorded: number;
    skipped: number;
  }> {
    const { categoryId, categoryName, categorySlug, config } = params;

    const searchResult = await this.duplicationSearchService.findDuplicates({
      categoryId,
      minSimilarity: config.minSimilarityThreshold,
      pageSize: config.batchSize,
    });

    const pairs = searchResult.items ?? [];
    let evaluated = 0;
    let recorded = 0;
    let skipped = 0;

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

      if (evaluation.outcome === 'skip') {
        skipped++;
        this.metricsService.skipped(
          categoryName,
          evaluation.reasons[0] ?? 'unknown',
        );
        continue;
      }

      this.metricsService.observeSimilarityScore(
        categoryName,
        evaluation.confident ? 'confident' : 'needs_review',
        pair.similarityScore,
      );

      // Record the pair for review — use in-process score as similarityScore.
      // Routed through the shared recorder so this write passes through the same
      // `resolution.minScoreToRecord` gate the resolution flow uses.
      //
      // Detection never merges, however confident it is. A duplicate pair is a
      // proposal; the merge happens when a human accepts the row, which is what
      // keeps every merge attributable and reversible.
      const saved = await this.resolutionRecorder.recordDuplicatePair({
        flow: ProductResolutionFlow.duplicate_detection,
        productAId: pair.productA.id,
        productBId: pair.productB.id,
        similarityScore: evaluation.inProcessScore ?? pair.similarityScore,
        specMatchDetails: evaluation.specMatchDetails,
        pendingReasons: evaluation.reasons,
        origin: ProductResolutionOrigin.nightly_detection,
        candidates: evaluation.candidates,
        inputSnapshot: evaluation.inputSnapshot,
        decisionConfidence: evaluation.inProcessScore,
      });

      if (!saved) {
        skipped++;
        this.metricsService.skipped(categoryName, 'product_not_found');
        continue;
      }

      recorded++;
      this.metricsService.pendingReview(categoryName);
    }

    return { evaluated, recorded, skipped };
  }

  private async evaluatePair(params: {
    productA: DuplicatePairItem;
    productB: DuplicatePairItem;
    trigramScore: number;
    config: DuplicateDetectionConfig;
    categorySlug?: string;
  }): Promise<PairEvaluation & { inProcessScore?: number }> {
    const { productA, productB, trigramScore, config, categorySlug } = params;

    // 1. A human already settled this pair — don't re-surface it. An open row is
    // fair game: re-evaluating refreshes its scores while it waits for review.
    const existing = await this.duplicateRepo.findExistingPair(
      productA.id,
      productB.id,
    );
    if (
      existing &&
      (existing.status === ProductResolutionStatus.done ||
        existing.status === ProductResolutionStatus.superseded)
    ) {
      return { outcome: 'skip', confident: false, reasons: ['already_reviewed'] };
    }

    // 1b. Trigram similarity floor — too low to even consider
    if (trigramScore < MIN_SIMILARITY_FLOOR) {
      return { outcome: 'skip', confident: false, reasons: ['below_similarity_floor'] };
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
        model: query.model ?? '',
        displayName: query.displayName,
        aliases: queryAliases,
        specs: query.specs,
      },
      candidate: {
        model: candidate.model ?? '',
        displayName: candidate.displayName,
        aliases: candidateAliases,
        specs: candidate.specs,
      },
      brandName: query.brandName || candidate.brandName,
      categorySlug,
      traceContext: { productId: candidate.id },
    });

    const inProcessScore = similarityResult.score;

    if (inProcessScore < config.minPendingReviewThreshold) {
      return { outcome: 'skip', confident: false, reasons: ['below_pending_review_threshold'] };
    }

    const specMatchDetails = similarityResult.specMatchDetails;

    this.logger.debug('Duplicate pair scored', {
      productAId: productA.id,
      productBId: productB.id,
      trigramScore,
      inProcessScore,
      components: similarityResult.components,
      specMatchDetails,
    });

    const belowThreshold = inProcessScore < config.autoMergeThreshold;

    const pendingReasons: string[] = [];
    const failedGates: string[] = [];

    // 4. Primary spec mismatch
    if (specMatchDetails && specMatchDetails.primaryMismatches > 0) {
      pendingReasons.push(
        `${specMatchDetails.primaryMismatches} primary spec mismatch(es)`,
      );
      failedGates.push('primary_spec_mismatch');
    }

    // 5. Too many non-primary mismatches
    if (
      specMatchDetails &&
      specMatchDetails.nonPrimaryMismatches > config.maxNonPrimaryMismatches
    ) {
      pendingReasons.push(
        `${specMatchDetails.nonPrimaryMismatches} non-primary mismatches > ${config.maxNonPrimaryMismatches}`,
      );
      failedGates.push('non_primary_mismatch_limit_exceeded');
    }

    if (belowThreshold) {
      failedGates.push('below_auto_merge_threshold');
    }

    const needsReview = belowThreshold || !isEmpty(pendingReasons);

    // Normalized single-candidate + input shape shared with the resolution
    // flow's own `candidates`/`gates`/`inputSnapshot` vocabulary — this is what
    // makes duplicate-detection rows genuinely comparable to resolution rows.
    const candidates: ProductResolutionCandidateRecord[] = [
      {
        candidateId: candidate.id,
        brand: candidate.brandName,
        model: candidate.model,
        displayName: candidate.displayName,
        source: 'duplicate_detection_pair',
        matchScore: inProcessScore,
        matchComponents: similarityResult.components,
        gates: { passed: !needsReview, failedGates },
        specMatchDetails,
      },
    ];
    const inputSnapshot: ProductDuplicateDetectionInputSnapshot = {
      kind: 'duplicate_detection',
      query: {
        model: query.model ?? '',
        displayName: query.displayName,
        aliases: queryAliases,
        specs: query.specs,
      },
      candidate: {
        model: candidate.model ?? '',
        displayName: candidate.displayName,
        aliases: candidateAliases,
        specs: candidate.specs,
      },
      brandName: query.brandName || candidate.brandName,
      categorySlug,
      trigramScore,
    };

    if (needsReview) {
      return {
        outcome: 'record',
        confident: false,
        reasons: belowThreshold
          ? [
              `in-process score ${inProcessScore} below threshold ${config.autoMergeThreshold}`,
              ...pendingReasons,
            ]
          : pendingReasons,
        specMatchDetails,
        inProcessScore,
        candidates,
        inputSnapshot,
      };
    }

    // All checks pass. Still only recorded, never merged — a confident pair is
    // just one that should sort to the top of the queue.
    return {
      outcome: 'record',
      confident: true,
      reasons: ['all_checks_passed'],
      specMatchDetails,
      inProcessScore,
      candidates,
      inputSnapshot,
    };
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
    };
  }
}
