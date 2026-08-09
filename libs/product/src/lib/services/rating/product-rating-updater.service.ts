import { Injectable } from "@nestjs/common";
import {
  ExperienceType,
  isHandsonExperience,
  ProductLabelSummary,
  ProductModel,
  ProductModelRepository,
  ProductRating,
  Review,
  ReviewLabelType,
  ReviewRepository,
  Sentiment,
} from "@ebike-backend/database";
import { RATING_DEFAULTS } from "@ebike-backend/config";
import { DebugTraceService } from "@ebike-backend/debug";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { CustomLogger } from "@ebike-backend/logger";
import { orderBy } from "lodash";

const SENTIMENT_SCORE: Record<Sentiment, number> = {
  [Sentiment.StrongPositive]: 1.0,
  [Sentiment.Positive]: 0.85,
  [Sentiment.Mixed]: 0.5,
  [Sentiment.Neutral]: 0.5,
  [Sentiment.Negative]: 0.2,
  [Sentiment.StrongNegative]: 0.0,
};

const EXPERIENCE_RATING_WEIGHT: Partial<Record<ExperienceType, number>> = {
  [ExperienceType.Owner]: 1.0,
  [ExperienceType.PriorOwner]: 1.0,
  [ExperienceType.Tested]: 0.8,
};

const VOTE_MULTIPLIER_MIN = 0.5;
const VOTE_MULTIPLIER_MAX = 2.0;
const QUALITY_WEIGHT_FLOOR = 0.2;

const NEUTRAL_PRIOR = 50;

interface LabelStats {
  // For each user, the maximum reviewWeight contributing them to this bucket.
  // Stored as Map<userId, weight> so a single user can move between buckets
  // when re-evaluated; we sum the weights at the end. Uniqueness per (userId)
  // still holds because Review is unique by (userId, model).
  strongPositive: Map<string, number>;
  positive: Map<string, number>;
  neutral: Map<string, number>;
  mixed: Map<string, number>;
  negative: Map<string, number>;
  strongNegative: Map<string, number>;
}

interface ReviewContribution {
  review: Review;
  /**
   * `max(candidate.weight for c in review.candidates where c.model = thisProduct)`
   * — derived per (review, product) at the start of recalculation. Almost
   * always 1.0; <1 only for ambiguous-only contributions to this product.
   */
  weight: number;
}

@Injectable()
export class ProductRatingUpdaterService {
  private readonly logger = new CustomLogger(ProductRatingUpdaterService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly reviewRepo: ReviewRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly debugTrace: DebugTraceService,
  ) {}

  public async updateProductRating(product: ProductModel): Promise<void> {
    const ratingConfig = this.dynamicConfigService.rating;
    const priorWeight =
      ratingConfig?.priorWeight ?? RATING_DEFAULTS.priorWeight;
    const minReviewScore =
      ratingConfig?.minReviewScore ?? RATING_DEFAULTS.minReviewScore;

    const allReviews = product.reviews ?? [];
    const enabledReviews = allReviews.filter(
      (review) => review.enabled && (review.reviewScore ?? 0) >= minReviewScore,
    );
    await this.recalculateRating(product, enabledReviews, priorWeight);

    const rating = product.rating;
    const handsonCount = rating?.handsonReviewCount ?? 0;
    const totalCount = rating?.totalReviewCount ?? 0;
    const speculativeCount = totalCount - handsonCount;
    this.logger.log(
      `Product ${product.displayName ?? product.id}: rating ${rating?.rating ?? "none"}, ` +
        `${handsonCount.toFixed(2)} hands-on / ${speculativeCount.toFixed(2)} speculative reviews ` +
        `(${enabledReviews.length} enabled of ${allReviews.length} total, min score ${minReviewScore}), ` +
        `features ${rating?.featureSummary?.length ?? 0}, use cases ${rating?.useCaseSummary?.length ?? 0}, issues ${rating?.issueSummary?.length ?? 0}`,
      { productId: product.id },
    );

    // Detach reviews before saving to prevent TypeORM from issuing UPDATE
    // statements on loaded Review entities (which would null out modelId).
    const reviews = product.reviews;
    delete product.reviews;

    // Force the rating's updatedAt forward so the scheduler's predicate
    // (review.updatedAt > rating.updatedAt) stops matching this product.
    // Without this, TypeORM skips the UPDATE when no rating fields changed,
    // and @UpdateDateColumn never fires.
    if (product.rating) {
      product.rating.updatedAt = new Date();
    }

    await this.productRepo.save(product);

    await this.cleanupSoftDeletedReviews(reviews ?? []);
  }

  private async cleanupSoftDeletedReviews(reviews: Review[]): Promise<void> {
    const deletedReviews = reviews.filter((review) => review.deletedAt != null);
    if (deletedReviews.length > 0) {
      await this.reviewRepo.deleteByIds(
        deletedReviews.map((review) => review.id),
      );
    }
  }

  /**
   * For each contributing review, compute its weight against this product as
   * the maximum of `candidate.weight` across all linked candidates whose
   * `model.id` matches the product. A review with a single non-ambiguous
   * candidate gets weight 1.0; a review whose only contributing candidate
   * is a runner-up gets that runner-up's softmax weight.
   */
  private toContributions(
    product: ProductModel,
    reviews: Review[],
  ): ReviewContribution[] {
    const productId = product.id;
    const contributions: ReviewContribution[] = [];
    for (const review of reviews) {
      const matchingWeights = (review.candidates ?? [])
        .filter((candidate) => candidate.model?.id === productId)
        .map((candidate) => candidate.weight ?? 1);
      // Fallback to 1 when the review has no loaded candidates (legacy data
      // or a stale snapshot) — preserves prior behavior of treating each
      // review as a full vote when we can't see its weight.
      const weight =
        matchingWeights.length > 0 ? Math.max(...matchingWeights) : 1;
      contributions.push({ review, weight });
    }
    return contributions;
  }

  private async recalculateRating(
    product: ProductModel,
    enabledReviews: Review[],
    priorWeight: number,
  ): Promise<void> {
    const useCasePriorWeight =
      this.dynamicConfigService.rating?.useCasePriorWeight ??
      RATING_DEFAULTS.useCasePriorWeight;
    const rating = this.getOrCreateRating(product);
    const previousRating = rating.rating;

    const priorFeatureSummary = rating.featureSummary ?? null;
    const priorUseCaseSummary = rating.useCaseSummary ?? null;
    const priorIssueSummary = rating.issueSummary ?? null;

    this.resetRating(rating);

    const contributions = this.toContributions(product, enabledReviews);

    const handsonContributions = contributions.filter((entry) =>
      isHandsonExperience(entry.review.experience),
    );

    this.countSentiments(contributions, handsonContributions, rating);

    if (handsonContributions.length === 0) {
      rating.rating = null;
      rating.averageReviewScore = null;
      return;
    }

    const totalWeight = handsonContributions.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    if (totalWeight === 0) {
      rating.rating = null;
      rating.averageReviewScore = null;
      return;
    }
    const totalScore = handsonContributions.reduce(
      (sum, entry) => sum + (entry.review.reviewScore ?? 0) * entry.weight,
      0,
    );
    rating.averageReviewScore = Math.round(totalScore / totalWeight);

    const overall = this.weightedSentimentAverage(handsonContributions);
    rating.rating =
      overall.preBayesian == null
        ? null
        : this.applyBayesianDampening(
            overall.preBayesian,
            overall.opinionN,
            priorWeight,
            rating.averageReviewScore ?? 50,
          );

    rating.featureSummary = this.aggregateByLabelType(
      handsonContributions,
      ReviewLabelType.Feature,
      "bayesian",
      priorWeight,
      priorFeatureSummary,
    );
    rating.useCaseSummary = this.aggregateByLabelType(
      handsonContributions,
      ReviewLabelType.UseCase,
      "bayesian",
      useCasePriorWeight,
      priorUseCaseSummary,
    );
    rating.issueSummary = this.aggregateByLabelType(
      handsonContributions,
      ReviewLabelType.Issue,
      "affected",
      priorWeight,
      priorIssueSummary,
    );

    rating.useCaseScores = this.buildLabelScoresMap(rating.useCaseSummary);
    rating.featureScores = this.buildLabelScoresMap(rating.featureSummary);
    rating.issueScores = this.buildLabelScoresMap(rating.issueSummary);

    await this.recordRatingTrace(
      product,
      enabledReviews,
      handsonContributions,
      rating,
      previousRating,
      priorWeight,
      overall,
    );
  }

  // ─── Sentiment Counting ──────────────────────────────────────────────────

  private countSentiments(
    contributions: ReviewContribution[],
    handsonContributions: ReviewContribution[],
    rating: ProductRating,
  ): void {
    for (const { review, weight } of handsonContributions) {
      switch (review.sentiment) {
        case Sentiment.StrongPositive:
          rating.strongPositiveReviewCount += weight;
          break;
        case Sentiment.Positive:
          rating.positiveReviewCount += weight;
          break;
        case Sentiment.StrongNegative:
          rating.strongNegativeReviewCount += weight;
          break;
        case Sentiment.Negative:
          rating.negativeReviewCount += weight;
          break;
        case Sentiment.Mixed:
          rating.mixedReviewCount += weight;
          break;
        case Sentiment.Neutral:
        default:
          rating.neutralReviewCount += weight;
          break;
      }
    }

    rating.totalReviewCount = contributions.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    rating.handsonReviewCount = handsonContributions.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
  }

  // ─── Weighted Rating Formula ─────────────────────────────────────────────

  private weightedSentimentAverage(contributions: ReviewContribution[]): {
    preBayesian: number | null;
    weightedSum: number;
    totalWeight: number;
    opinionN: number;
    excludedNeutralCount: number;
  } {
    let weightedSum = 0;
    let totalWeight = 0;
    let opinionN = 0;
    let excludedNeutralCount = 0;

    for (const { review, weight: reviewWeight } of contributions) {
      const sentiment = review.sentiment;
      if (sentiment === Sentiment.Neutral) {
        excludedNeutralCount++;
        continue;
      }
      const sentimentScore = SENTIMENT_SCORE[sentiment] ?? 0.5;
      const qualityWeight = Math.max(
        QUALITY_WEIGHT_FLOOR,
        (review.reviewScore ?? 0) / 100,
      );
      const voteMultiplier = this.calculateVoteMultiplier(review);
      const experienceWeight =
        EXPERIENCE_RATING_WEIGHT[review.experience] ?? 0.5;
      // reviewWeight is the per-(review, product) ambiguity weight; it
      // attenuates the entire contribution rather than any single sub-factor.
      const weight =
        qualityWeight * voteMultiplier * experienceWeight * reviewWeight;

      weightedSum += sentimentScore * weight;
      totalWeight += weight;
      opinionN += reviewWeight;
    }

    const preBayesian =
      totalWeight > 0 ? Math.round(1 + (weightedSum / totalWeight) * 99) : null;
    return {
      preBayesian,
      weightedSum,
      totalWeight,
      opinionN,
      excludedNeutralCount,
    };
  }

  private calculateVoteMultiplier(review: Review): number {
    const netVotes = (review.totalUpvotes ?? 0) - (review.totalDownvotes ?? 0);

    const raw =
      netVotes >= 0
        ? 1 + Math.log2(Math.max(1, netVotes + 1)) * 0.15
        : 1 + netVotes * 0.05;

    return Math.min(VOTE_MULTIPLIER_MAX, Math.max(VOTE_MULTIPLIER_MIN, raw));
  }

  // ─── Bayesian Dampening ──────────────────────────────────────────────────

  private applyBayesianDampening(
    rawRating: number,
    opinionCount: number,
    priorWeight: number,
    averageReviewScore: number,
  ): number {
    const qualityFactor = 0.5 + 0.5 * (averageReviewScore / 100);
    const effectivePriorWeight = priorWeight / qualityFactor;

    return Math.round(
      (rawRating * opinionCount + NEUTRAL_PRIOR * effectivePriorWeight) /
        (opinionCount + effectivePriorWeight),
    );
  }

  // ─── Label-based Aggregation ─────────────────────────────────────────────

  private aggregateByLabelType(
    contributions: ReviewContribution[],
    type: ReviewLabelType,
    scoreMode: "bayesian" | "affected",
    priorWeight: number,
    priorSummary: ProductLabelSummary[] | null,
  ): ProductLabelSummary[] | null {
    const stats = new Map<string, LabelStats>();

    for (const { review, weight } of contributions) {
      for (const label of review.labels ?? []) {
        if (label.type !== type) continue;
        const entry = stats.get(label.label) ?? this.emptyLabelStats();
        this.addUserToBucket(entry, label.sentiment, review.userId, weight);
        stats.set(label.label, entry);
      }
    }

    if (stats.size === 0) return null;

    const priorByName = new Map<string, ProductLabelSummary>();
    for (const entry of priorSummary ?? []) {
      priorByName.set(entry.name, entry);
    }

    const handsonWeight = contributions.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    const summaries: ProductLabelSummary[] = [];
    for (const [name, entry] of stats) {
      const strongPositiveCount = sumMap(entry.strongPositive);
      const positiveCount = sumMap(entry.positive);
      const neutralCount = sumMap(entry.neutral);
      const mixedCount = sumMap(entry.mixed);
      const negativeCount = sumMap(entry.negative);
      const strongNegativeCount = sumMap(entry.strongNegative);
      const mentionCount =
        strongPositiveCount +
        positiveCount +
        neutralCount +
        mixedCount +
        negativeCount +
        strongNegativeCount;

      const score =
        scoreMode === "bayesian"
          ? this.bayesianProShareScore(
              strongPositiveCount,
              positiveCount,
              strongNegativeCount,
              negativeCount,
              priorWeight,
            )
          : this.affectedRatioScore(mentionCount, handsonWeight);

      const prior = priorByName.get(name);

      summaries.push({
        name,
        mentionCount,
        strongPositiveCount,
        positiveCount,
        neutralCount,
        mixedCount,
        negativeCount,
        strongNegativeCount,
        score,
        ...(prior?.headline != null && { headline: prior.headline }),
        ...(prior?.narrative != null && { narrative: prior.narrative }),
        ...(prior?.narrativeGeneratedAt != null && {
          narrativeGeneratedAt: prior.narrativeGeneratedAt,
        }),
      });
    }

    return orderBy(summaries, ["mentionCount", "score"], ["desc", "desc"]);
  }

  private emptyLabelStats(): LabelStats {
    return {
      strongPositive: new Map<string, number>(),
      positive: new Map<string, number>(),
      neutral: new Map<string, number>(),
      mixed: new Map<string, number>(),
      negative: new Map<string, number>(),
      strongNegative: new Map<string, number>(),
    };
  }

  private addUserToBucket(
    entry: LabelStats,
    sentiment: Sentiment,
    userId: string,
    weight: number,
  ): void {
    // Uniqueness: a user contributes at most once per (label, sentiment)
    // bucket. If they happen to land in the same bucket twice (e.g.
    // re-evaluation race), keep the larger weight.
    const bucket = this.selectBucket(entry, sentiment);
    if (!bucket) return;
    const current = bucket.get(userId) ?? 0;
    if (weight > current) bucket.set(userId, weight);
  }

  private selectBucket(
    entry: LabelStats,
    sentiment: Sentiment,
  ): Map<string, number> | undefined {
    switch (sentiment) {
      case Sentiment.StrongPositive:
        return entry.strongPositive;
      case Sentiment.Positive:
        return entry.positive;
      case Sentiment.Neutral:
        return entry.neutral;
      case Sentiment.Mixed:
        return entry.mixed;
      case Sentiment.Negative:
        return entry.negative;
      case Sentiment.StrongNegative:
        return entry.strongNegative;
      default:
        return undefined;
    }
  }

  /**
   * Bayesian pro-share: prior-dampened share of positive vs negative voices.
   * 100 = fully praised, 50 = balanced (or no opinion), 0 = fully criticised.
   */
  private bayesianProShareScore(
    strongPositiveCount: number,
    positiveCount: number,
    strongNegativeCount: number,
    negativeCount: number,
    priorWeight: number,
  ): number {
    const pros = strongPositiveCount + positiveCount;
    const cons = strongNegativeCount + negativeCount;
    return Math.round(
      ((pros + priorWeight * 0.5) / (pros + cons + priorWeight)) * 100,
    );
  }

  /**
   * Affected ratio: share of hands-on reviewers (weighted) who mentioned this issue.
   */
  private affectedRatioScore(
    mentionCount: number,
    handsonWeight: number,
  ): number {
    return Math.round((mentionCount / Math.max(handsonWeight, 1)) * 100);
  }

  private buildLabelScoresMap(
    summary: ProductLabelSummary[] | null,
  ): Record<string, number> | null {
    if (!summary?.length) return null;
    const map: Record<string, number> = {};
    for (const entry of summary) {
      map[entry.name] = entry.score;
    }
    return map;
  }

  // ─── Rating Management ───────────────────────────────────────────────────

  private getOrCreateRating(product: ProductModel): ProductRating {
    if (product.rating) {
      return product.rating;
    }

    const rating = new ProductRating();
    product.rating = rating;
    rating.model = product;
    this.resetRating(rating);
    return rating;
  }

  private resetRating(rating: ProductRating): void {
    rating.strongPositiveReviewCount = 0;
    rating.positiveReviewCount = 0;
    rating.negativeReviewCount = 0;
    rating.strongNegativeReviewCount = 0;
    rating.neutralReviewCount = 0;
    rating.mixedReviewCount = 0;
    rating.totalReviewCount = 0;
    rating.handsonReviewCount = 0;
    rating.rating = null;
    rating.averageReviewScore = null;
    rating.featureSummary = null;
    rating.useCaseSummary = null;
    rating.issueSummary = null;
    rating.useCaseScores = null;
    rating.featureScores = null;
    rating.issueScores = null;
  }

  // ─── Trace Recording ──────────────────────────────────────────────────────

  private async recordRatingTrace(
    product: ProductModel,
    enabledReviews: Review[],
    handsonContributions: ReviewContribution[],
    rating: ProductRating,
    previousRating: number | null | undefined,
    priorWeight: number,
    overall: {
      preBayesian: number | null;
      weightedSum: number;
      totalWeight: number;
      opinionN: number;
      excludedNeutralCount: number;
    },
  ): Promise<void> {
    try {
      if (!this.dynamicConfigService.debug?.traceEnabled) return;

      const productId = product.id;
      const minReviewScore =
        this.dynamicConfigService.rating?.minReviewScore ??
        RATING_DEFAULTS.minReviewScore;
      const totalReviews = (product.reviews ?? []).length;

      const perReviewWeights = handsonContributions.map(
        ({ review, weight: reviewWeight }) => {
          const sentimentScore = SENTIMENT_SCORE[review.sentiment] ?? 0.5;
          const qualityWeight = Math.max(
            QUALITY_WEIGHT_FLOOR,
            (review.reviewScore ?? 0) / 100,
          );
          const voteMultiplier = this.calculateVoteMultiplier(review);
          const experienceWeight =
            EXPERIENCE_RATING_WEIGHT[review.experience] ?? 0.5;
          const finalWeight =
            qualityWeight * voteMultiplier * experienceWeight * reviewWeight;
          const excluded = review.sentiment === Sentiment.Neutral;
          const weightedSentiment = excluded ? 0 : sentimentScore * finalWeight;
          return {
            reviewId: review.id,
            sentiment: review.sentiment,
            sentimentScore,
            reviewScore: review.reviewScore ?? 0,
            qualityWeight,
            netVotes: (review.totalUpvotes ?? 0) - (review.totalDownvotes ?? 0),
            voteMultiplier,
            experience: review.experience,
            experienceWeight,
            reviewWeight,
            finalWeight: excluded ? 0 : finalWeight,
            weightedSentiment,
            excluded,
          };
        },
      );

      const averageReviewScore = rating.averageReviewScore ?? 50;
      const qualityFactor = 0.5 + 0.5 * (averageReviewScore / 100);
      const effectivePriorWeight = priorWeight / qualityFactor;

      await this.debugTrace.record({
        productId,
        step: "product_rating",
        statusBefore:
          previousRating != null ? `rating_${previousRating}` : "no_rating",
        statusAfter:
          rating.rating != null ? `rating_${rating.rating}` : "no_rating",
        durationMs: 0,
        data: {
          summary: `Product ${productId}: rating ${previousRating ?? "none"} → ${rating.rating ?? "none"}, ${enabledReviews.length} reviews (opinionN=${overall.opinionN.toFixed(2)}, excludedNeutral=${overall.excludedNeutralCount})`,
          productRating: {
            productId,
            previousRating: previousRating ?? null,
            filtering: {
              totalReviews,
              enabledReviews: enabledReviews.length,
              minScoreThreshold: minReviewScore,
            },
            sentimentDistribution: {
              strongPositive: rating.strongPositiveReviewCount,
              positive: rating.positiveReviewCount,
              negative: rating.negativeReviewCount,
              strongNegative: rating.strongNegativeReviewCount,
              mixed: rating.mixedReviewCount,
              neutral: rating.neutralReviewCount,
              total: rating.totalReviewCount,
              ownerCount: rating.handsonReviewCount,
              prospectiveBuyerCount:
                rating.totalReviewCount - rating.handsonReviewCount,
            },
            averageReviewScore,
            perReviewWeights,
            weightedSentimentSum: overall.weightedSum,
            totalWeight: overall.totalWeight,
            opinionN: overall.opinionN,
            excludedNeutralCount: overall.excludedNeutralCount,
            preBayesianRating: overall.preBayesian,
            bayesian: {
              priorWeight,
              qualityFactor,
              effectivePriorWeight,
              finalRating: rating.rating ?? null,
            },
          },
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record rating trace", { error });
    }
  }
}

function sumMap(bucket: Map<string, number>): number {
  let sum = 0;
  for (const value of bucket.values()) sum += value;
  return sum;
}
