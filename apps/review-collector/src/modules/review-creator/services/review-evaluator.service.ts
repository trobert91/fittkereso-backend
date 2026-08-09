import { Injectable } from "@nestjs/common";
import {
  consolidateSentiment,
  DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS,
  DEFAULT_QUALITY_WEIGHTS,
  Depth,
  effectiveSentiment,
  Evidence,
  ExperienceType,
  getIssueLabels,
  Intent,
  isHearsay,
  isNegativeSentiment,
  isPositiveSentiment,
  LabelConsolidationThresholds,
  ProductReference,
  ProductReferenceCandidate,
  QualityWeights,
  qualityWeightOf,
  Quote,
  Review,
  ReviewDetails,
  ReviewLabel,
  ReviewLabelType,
  Sentiment,
  WeightedEntry,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import {
  containsNearDuplicateSubstring,
  isNearDuplicateText,
} from "@ebike-backend/utils";
import { chain, isEmpty, uniq } from "lodash";

const EXPERIENCE_PRIORITY: Record<ExperienceType, number> = {
  [ExperienceType.Owner]: 5,
  [ExperienceType.PriorOwner]: 4,
  [ExperienceType.Tested]: 3,
  [ExperienceType.ProspectiveBuyer]: 2,
  [ExperienceType.Reference]: 1,
};

const INTENT_PRIORITY: Record<Intent, number> = {
  [Intent.Recommendation]: 5,
  [Intent.IssueReport]: 4,
  [Intent.Warning]: 3,
  [Intent.Comparison]: 2,
  [Intent.ExperienceReport]: 1,
  [Intent.ReputationReport]: 1,
  [Intent.Question]: 0,
  [Intent.SeekingAdvice]: 0,
};

const EXPERIENCE_SENTIMENT_WEIGHT: Record<ExperienceType, number> = {
  [ExperienceType.Owner]: 1.5,
  [ExperienceType.PriorOwner]: 1.3,
  [ExperienceType.Tested]: 1.1,
  [ExperienceType.ProspectiveBuyer]: 1.0,
  [ExperienceType.Reference]: 0.8,
};

const DEPTH_PRIORITY: Record<Depth, number> = {
  [Depth.Comprehensive]: 4,
  [Depth.Detailed]: 3,
  [Depth.Mentioned]: 2,
  [Depth.Superficial]: 1,
};

const DEPTH_SCORE: Record<Depth, number> = {
  [Depth.Comprehensive]: 20,
  [Depth.Detailed]: 14,
  [Depth.Mentioned]: 8,
  [Depth.Superficial]: 0,
};

const EXPERIENCE_SCORE: Record<ExperienceType, number> = {
  [ExperienceType.Owner]: 30,
  [ExperienceType.PriorOwner]: 24,
  [ExperienceType.Tested]: 18,
  [ExperienceType.ProspectiveBuyer]: 8,
  [ExperienceType.Reference]: 2,
};

// Positive-rate valence: how much each sentiment counts toward "this is
// a positive review". Neutral is intentionally absent — neutral quotes /
// references don't contribute to sentiment voting (preserves prior
// behavior). Strong tiers collapse to the same valence as mild —
// intensity is recovered separately by counting strong-tier
// contributions and promoting the final tier when the strong share
// dominates.
const SENTIMENT_VALENCE: Partial<Record<Sentiment, number>> = {
  [Sentiment.StrongPositive]: 1.0,
  [Sentiment.Positive]: 1.0,
  [Sentiment.Mixed]: 0.5,
  [Sentiment.Negative]: 0.0,
  [Sentiment.StrongNegative]: 0.0,
};
const SENTIMENT_POSITIVE_THRESHOLD = 0.65;
const SENTIMENT_NEGATIVE_THRESHOLD = 0.35;
// When the share of strong-tier contributions among directional inputs
// passes this fraction, promote Positive→StrongPositive (or
// Negative→StrongNegative).
const STRONG_TIER_SHARE_THRESHOLD = 0.5;
const MAX_INTENTS = 3;
const MAX_QUALITY_SCORE = 25;
const REFERENCE_QUALITY_HIGH_POINTS = 5;
const REFERENCE_QUALITY_MEDIUM_POINTS = 2;
const QUOTE_QUALITY_HIGH_POINTS = 2;
const QUOTE_QUALITY_MEDIUM_POINTS = 0.8;
const MAX_COMMUNITY_SCORE = 10;
const MAX_FEATURE_COVERAGE_BONUS = 15;
const FEATURE_SCORE_PER_HIGHLIGHT = 3;
const HEARSAY_PENALTY = 0.5;
const NON_VOTING_INTENTS = new Set<Intent>([
  Intent.SeekingAdvice,
  Intent.Question,
]);
const MAX_REVIEW_SCORE = 100;
const DEDUP_SIMILARITY_THRESHOLD = 0.9;
const FEATURE_OVERLAP_DEDUP_THRESHOLD = 0.65;
const NEAR_SUBSTRING_DEDUP_THRESHOLD = 0.92;
const DEFAULT_TOP_QUOTE_LIMIT = 8;
/** Minimum candidate weight to be counted as a contributing "part" of the
 *  review. Filters out tiny-weight runner-ups whose contribution is real but
 *  too fractional to call a distinct sourcing instance. */
const MIN_PART_WEIGHT = 0.2;

// Per-quote scoring weights used by scoreQuote() to rank quotes for the
// review.quotes top-N cap. Quality dominates the other signals so a single
// high-quality quote always outranks any combination of medium-quality bonuses.
const QUOTE_QUALITY_HIGH = 50;
const QUOTE_QUALITY_MEDIUM = 15;
const QUOTE_FIRSTHAND_BONUS = 10;
const QUOTE_SENTIMENT_DIRECTIONAL = 8; // positive / negative
const QUOTE_SENTIMENT_MIXED = 4;
const QUOTE_RICHNESS_MULTIPLIER = 2;
const QUOTE_RICHNESS_MAX = 12;

export interface SentimentAggregationBreakdown {
  finalSentiment: string;
  positiveRatio: number;
  positiveThreshold: number;
  negativeThreshold: number;
  weightedPositive: number;
  weightedTotal: number;
  perReferenceWeights: Array<{
    referenceId: string;
    candidateWeight: number;
    experienceWeight: number;
    relevanceFactor: number;
    baseWeight: number;
    quoteCount: number;
  }>;
}

export interface ReviewScoreBreakdown {
  finalScore: number;
  depthScore: number;
  depthInput: string;
  experienceScore: number;
  experienceInput: string;
  qualityScore: number;
  partCount: number;
  communityScore: number;
  netVotes: number;
  featureCoverageBonus: number;
  prosCount: number;
  consCount: number;
  isHearsay: boolean;
  rawScore: number;
}

export interface ReviewEvaluationResult {
  sentimentBreakdown: SentimentAggregationBreakdown;
  scoreBreakdown: ReviewScoreBreakdown;
  selectedExperience: string;
  selectedDepth: string;
  selectedIntents: string[];
}

/** A candidate that contributes to this review, paired with its source
 *  reference. The reference is already loaded by `loadReviewByUserAndModel` /
 *  `fetchCommentsForUserAndProduct` in `ReviewUpdaterService`. */
interface ReviewContribution {
  candidate: ProductReferenceCandidate;
  reference: ProductReference;
  weight: number;
}

@Injectable()
export class ReviewEvaluatorService {
  constructor(
    private readonly dynamicConfig: DynamicConfigService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async evaluate(
    review: Review,
  ): Promise<ReviewEvaluationResult | undefined> {
    const contributions = this.collectContributions(review);
    if (isEmpty(contributions)) {
      return undefined;
    }

    review.externalCreationTs = chain(contributions)
      .map((entry) => entry.reference.comment?.externalCreationTs)
      .compact()
      .max()
      .value();

    review.quotes = this.selectTopQuotes(contributions);
    review.labels = this.deriveLabels(review, contributions);

    const sentimentBreakdown =
      this.evaluateSentimentWithBreakdown(contributions);
    review.sentiment = sentimentBreakdown.finalSentiment as Sentiment;
    review.intents = this.evaluateIntents(contributions);
    review.experience = this.evaluateExperience(contributions);
    review.depth = this.evaluateDepth(contributions);
    review.reviewDetails = this.aggregateDetails(contributions);
    const scoreBreakdown = this.calculateReviewScoreWithBreakdown(
      review,
      contributions,
    );
    review.reviewScore = scoreBreakdown.finalScore;

    return {
      sentimentBreakdown,
      scoreBreakdown,
      selectedExperience: review.experience,
      selectedDepth: review.depth,
      selectedIntents: review.intents,
    };
  }

  /**
   * Build the contribution list — one per linked candidate. Each contribution
   * carries the candidate, its source reference, and the candidate's softmax
   * weight (used to attenuate the reference's contribution to weighted
   * aggregates). Candidates without a loaded reference are dropped — a missing
   * reference is a load-time bug, not a runtime condition we want to silently
   * tolerate downstream.
   */
  private collectContributions(review: Review): ReviewContribution[] {
    const candidates = review.candidates ?? [];
    const contributions: ReviewContribution[] = [];
    for (const candidate of candidates) {
      const reference = candidate.reference;
      if (!reference) continue;
      contributions.push({
        candidate,
        reference,
        weight: candidate.weight ?? 1,
      });
    }
    return contributions;
  }

  // ─── Quote Selection (dedup → score → sort → cap) ────────────────────────

  private selectTopQuotes(contributions: ReviewContribution[]): Quote[] {
    const deduped = this.deduplicateQuotes(contributions);
    const limit =
      this.dynamicConfig.review?.topQuoteLimit ?? DEFAULT_TOP_QUOTE_LIMIT;
    return [...deduped]
      .map((entry) => ({
        quote: entry.quote,
        score: this.scoreQuote(entry.quote) * entry.weight,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.quote);
  }

  private scoreQuote(quote: Quote): number {
    const qualityScore =
      quote.quality === "high" ? QUOTE_QUALITY_HIGH : QUOTE_QUALITY_MEDIUM;
    const firsthandScore = this.isSpeculativeQuote(quote)
      ? 0
      : QUOTE_FIRSTHAND_BONUS;

    let sentimentScore = 0;
    switch (quote.sentiment) {
      case Sentiment.StrongPositive:
      case Sentiment.StrongNegative:
        sentimentScore = QUOTE_SENTIMENT_DIRECTIONAL;
        break;
      case Sentiment.Positive:
      case Sentiment.Negative:
        sentimentScore = QUOTE_SENTIMENT_DIRECTIONAL;
        break;
      case Sentiment.Mixed:
        sentimentScore = QUOTE_SENTIMENT_MIXED;
        break;
      case Sentiment.Neutral:
      default:
        sentimentScore = 0;
        break;
    }

    const featureCount = quote.features?.length ?? 0;
    const useCaseCount = quote.useCases?.length ?? 0;
    const conEvidenceCount = (quote.features ?? []).filter((evidence) =>
      isNegativeSentiment(effectiveSentiment(evidence, quote)),
    ).length;
    const richnessScore = Math.min(
      QUOTE_RICHNESS_MAX,
      (featureCount + useCaseCount + conEvidenceCount) *
        QUOTE_RICHNESS_MULTIPLIER,
    );

    return qualityScore + firsthandScore + sentimentScore + richnessScore;
  }

  // ─── Sentiment ────────────────────────────────────────────────────────────

  private evaluateSentimentWithBreakdown(
    contributions: ReviewContribution[],
  ): SentimentAggregationBreakdown {
    let weightedPositive = 0;
    let weightedTotal = 0;
    let strongPositiveWeight = 0;
    let strongNegativeWeight = 0;
    let directionalWeight = 0;
    const perReferenceWeights: SentimentAggregationBreakdown["perReferenceWeights"] =
      [];

    const recordContribution = (
      sentiment: Sentiment | null | undefined,
      weight: number,
    ): void => {
      if (sentiment == null) return;
      const score = SENTIMENT_VALENCE[sentiment];
      if (score == null) return;
      weightedPositive += weight * score;
      weightedTotal += weight;
      if (sentiment === Sentiment.Mixed) return;
      directionalWeight += weight;
      if (sentiment === Sentiment.StrongPositive) {
        strongPositiveWeight += weight;
      } else if (sentiment === Sentiment.StrongNegative) {
        strongNegativeWeight += weight;
      }
    };

    for (const { reference, weight: candidateWeight } of contributions) {
      const experienceWeight =
        EXPERIENCE_SENTIMENT_WEIGHT[
          reference.experience ?? ExperienceType.Reference
        ];
      const relevanceFactor = (reference.relevance ?? 50) / 100;
      const baseWeight = experienceWeight * relevanceFactor * candidateWeight;
      const quotes = reference.quotes ?? [];

      perReferenceWeights.push({
        referenceId: reference.id,
        candidateWeight,
        experienceWeight,
        relevanceFactor,
        baseWeight,
        quoteCount: quotes.length,
      });

      if (quotes.length === 0) {
        recordContribution(reference.sentiment, baseWeight);
        continue;
      }

      // Filter out speculative quotes from sentiment voting; the quote-level
      // flag is the authoritative stance. Low-quality quotes are also excluded.
      const contributingQuotes = quotes.filter(
        (quote) => !this.isSpeculativeQuote(quote) && quote.quality !== "low",
      );

      const quoteWeight =
        baseWeight / Math.max(1, Math.log2(contributingQuotes.length + 1));

      for (const quote of contributingQuotes) {
        recordContribution(quote.sentiment, quoteWeight);
      }
    }

    const referenceCount = contributions.length;
    const positiveThreshold = Math.max(
      0.55,
      SENTIMENT_POSITIVE_THRESHOLD - Math.min(0.1, (referenceCount - 1) * 0.02),
    );
    const negativeThreshold = Math.min(
      0.45,
      SENTIMENT_NEGATIVE_THRESHOLD + Math.min(0.1, (referenceCount - 1) * 0.02),
    );

    let finalSentiment: Sentiment;
    if (weightedTotal === 0) {
      finalSentiment = Sentiment.Neutral;
    } else {
      const positiveRatio = weightedPositive / weightedTotal;
      if (positiveRatio > positiveThreshold) {
        const strongShare =
          directionalWeight > 0 ? strongPositiveWeight / directionalWeight : 0;
        finalSentiment =
          strongShare >= STRONG_TIER_SHARE_THRESHOLD
            ? Sentiment.StrongPositive
            : Sentiment.Positive;
      } else if (positiveRatio < negativeThreshold) {
        const strongShare =
          directionalWeight > 0 ? strongNegativeWeight / directionalWeight : 0;
        finalSentiment =
          strongShare >= STRONG_TIER_SHARE_THRESHOLD
            ? Sentiment.StrongNegative
            : Sentiment.Negative;
      } else {
        finalSentiment = Sentiment.Mixed;
      }
    }

    return {
      finalSentiment,
      positiveRatio: weightedTotal > 0 ? weightedPositive / weightedTotal : 0,
      positiveThreshold,
      negativeThreshold,
      weightedPositive,
      weightedTotal,
      perReferenceWeights,
    };
  }

  // ─── Intents ──────────────────────────────────────────────────────────────

  private evaluateIntents(contributions: ReviewContribution[]): Intent[] {
    // Intents are a set operation — weights don't apply, every contributing
    // reference's intents enter the union.
    const allIntents = contributions.flatMap(
      (entry) => entry.reference.intents ?? [],
    );
    const uniqueIntents = uniq(allIntents);

    return chain(uniqueIntents)
      .orderBy((intent) => INTENT_PRIORITY[intent] ?? 0, "desc")
      .take(MAX_INTENTS)
      .value();
  }

  // ─── Experience ───────────────────────────────────────────────────────────

  private evaluateExperience(
    contributions: ReviewContribution[],
  ): ExperienceType {
    // Best-evidence semantics — the strongest experience across contributing
    // refs wins. Weights don't apply.
    return chain(contributions)
      .map((entry) => entry.reference.experience ?? ExperienceType.Reference)
      .maxBy((experience) => EXPERIENCE_PRIORITY[experience])
      .value();
  }

  // ─── Depth ────────────────────────────────────────────────────────────────

  private evaluateDepth(contributions: ReviewContribution[]): Depth {
    // Best-evidence semantics — the deepest contributing ref wins.
    return chain(contributions)
      .map((entry) => entry.reference.depth ?? Depth.Superficial)
      .maxBy((depth) => DEPTH_PRIORITY[depth])
      .value();
  }

  // ─── Review Score ─────────────────────────────────────────────────────────

  private calculateReviewScoreWithBreakdown(
    review: Review,
    contributions: ReviewContribution[],
  ): ReviewScoreBreakdown {
    const depth = review.depth ?? Depth.Superficial;
    const experience = review.experience ?? ExperienceType.Reference;

    // partCount = unique references whose candidate weight clears the floor.
    // A single reference with multiple candidates only counts once here.
    const uniqueRefIds = new Set<string>();
    for (const entry of contributions) {
      if (entry.weight >= MIN_PART_WEIGHT && entry.reference?.id) {
        uniqueRefIds.add(entry.reference.id);
      }
    }
    review.partCount = uniqueRefIds.size;
    review.totalQuoteCount = (review.quotes ?? []).length;

    let weightedUpvotes = 0;
    let weightedDownvotes = 0;
    for (const { reference, weight } of contributions) {
      if (!this.shouldCountVotes(reference.intents)) continue;
      weightedUpvotes += (reference.comment?.upvotes ?? 0) * weight;
      weightedDownvotes += (reference.comment?.downvotes ?? 0) * weight;
    }
    review.totalUpvotes = Math.round(weightedUpvotes);
    review.totalDownvotes = Math.round(weightedDownvotes);

    const depthScore = DEPTH_SCORE[depth];
    const experienceScore = EXPERIENCE_SCORE[experience];
    const qualityScore = this.calculateQualityScore(contributions);
    const netVotes = review.totalUpvotes - review.totalDownvotes;
    const communityScore = this.calculateCommunityScore(
      review.totalUpvotes,
      review.totalDownvotes,
    );
    let prosCount = 0;
    let consCount = 0;
    for (const label of review.labels ?? []) {
      if (label.type !== ReviewLabelType.Feature) continue;
      if (isPositiveSentiment(label.sentiment)) prosCount++;
      else if (isNegativeSentiment(label.sentiment)) consCount++;
    }
    const featureCoverageBonus = Math.min(
      MAX_FEATURE_COVERAGE_BONUS,
      (prosCount + consCount) * FEATURE_SCORE_PER_HIGHLIGHT,
    );

    const rawScore =
      depthScore +
      experienceScore +
      qualityScore +
      communityScore +
      featureCoverageBonus;
    const hearsay = isHearsay(experience, depth);
    const finalScore = Math.round(
      Math.min(MAX_REVIEW_SCORE, rawScore * (hearsay ? HEARSAY_PENALTY : 1.0)),
    );

    return {
      finalScore,
      depthScore,
      depthInput: depth,
      experienceScore,
      experienceInput: experience,
      qualityScore,
      partCount: review.partCount,
      communityScore,
      netVotes,
      featureCoverageBonus,
      prosCount,
      consCount,
      isHearsay: hearsay,
      rawScore,
    };
  }

  private calculateQualityScore(contributions: ReviewContribution[]): number {
    let points = 0;

    for (const { reference, weight } of contributions) {
      const referenceQuality =
        reference.context?.identification?.contentQuality;
      if (referenceQuality === "high") {
        points += REFERENCE_QUALITY_HIGH_POINTS * weight;
      } else if (referenceQuality === "medium") {
        points += REFERENCE_QUALITY_MEDIUM_POINTS * weight;
      }

      for (const quote of reference.quotes ?? []) {
        if (quote.quality === "low" || this.isSpeculativeQuote(quote)) continue;
        if (quote.quality === "high") {
          points += QUOTE_QUALITY_HIGH_POINTS * weight;
        } else if (quote.quality === "medium") {
          points += QUOTE_QUALITY_MEDIUM_POINTS * weight;
        }
      }
    }

    return Math.round(Math.min(MAX_QUALITY_SCORE, points));
  }

  private calculateCommunityScore(
    totalUpvotes: number,
    totalDownvotes: number,
  ): number {
    const netVotes = totalUpvotes - totalDownvotes;
    if (netVotes <= 0) {
      return 0;
    }
    return Math.round(
      Math.min(MAX_COMMUNITY_SCORE, Math.log2(netVotes + 1) * 4),
    );
  }

  private shouldCountVotes(intents: Intent[] | undefined): boolean {
    if (!intents || intents.length === 0) return true;

    let highestPriority = -1;
    let highestIntent: Intent | undefined;

    for (const intent of intents) {
      const priority = INTENT_PRIORITY[intent] ?? 0;
      if (priority > highestPriority) {
        highestPriority = priority;
        highestIntent = intent;
      }
    }

    return (
      highestIntent !== undefined && !NON_VOTING_INTENTS.has(highestIntent)
    );
  }

  // ─── Quote Deduplication ─────────────────────────────────────────────────

  private deduplicateQuotes(
    contributions: ReviewContribution[],
  ): Array<{ quote: Quote; weight: number }> {
    const uniqueQuotes: Array<{ quote: Quote; weight: number }> = [];

    for (const { reference, weight } of contributions) {
      for (const quote of reference.quotes ?? []) {
        if (!quote.text || quote.quality === "low") continue;

        const duplicateIndex = uniqueQuotes.findIndex((existing) =>
          this.areQuotesNearDuplicate(existing.quote, quote),
        );

        if (duplicateIndex === -1) {
          uniqueQuotes.push({ quote: { ...quote }, weight });
        } else {
          const existing = uniqueQuotes[duplicateIndex];
          uniqueQuotes[duplicateIndex] = {
            quote: this.mergeQuotes(existing.quote, quote),
            // Keep the larger candidate weight when two contributions merge —
            // the merged quote represents whichever side has more confidence.
            weight: Math.max(existing.weight, weight),
          };
        }
      }
    }

    return uniqueQuotes;
  }

  private areQuotesNearDuplicate(quoteA: Quote, quoteB: Quote): boolean {
    // Cross-sentiment near-identical quotes signal real disagreement and are
    // intentionally kept separate.
    if (quoteA.sentiment !== quoteB.sentiment) return false;

    const labelsA = (quoteA.features ?? []).map((e) => e.label);
    const labelsB = new Set((quoteB.features ?? []).map((e) => e.label));
    const hasSharedFeatures = labelsA.some((label) => labelsB.has(label));

    const threshold = hasSharedFeatures
      ? FEATURE_OVERLAP_DEDUP_THRESHOLD
      : DEDUP_SIMILARITY_THRESHOLD;
    if (isNearDuplicateText(quoteA.text, quoteB.text, threshold)) return true;

    // Fallback: catch the "longer quote almost contains the shorter quote" case
    // (e.g. minor edits or restatements within a larger sentence).
    const [longer, shorter] =
      quoteA.text.length >= quoteB.text.length
        ? [quoteA.text, quoteB.text]
        : [quoteB.text, quoteA.text];
    return containsNearDuplicateSubstring(
      longer,
      shorter,
      NEAR_SUBSTRING_DEDUP_THRESHOLD,
    );
  }

  private mergeQuotes(existing: Quote, incoming: Quote): Quote {
    const text =
      existing.text.length >= incoming.text.length
        ? existing.text
        : incoming.text;
    const features = this.mergeEvidence(
      existing.features ?? [],
      incoming.features ?? [],
    );
    const useCases = this.mergeEvidence(
      existing.useCases ?? [],
      incoming.useCases ?? [],
    );
    // Quality 'high' beats 'medium'. Both must be non-low here (low quality is
    // filtered before dedup).
    const quality: Quote["quality"] =
      existing.quality === "high" || incoming.quality === "high"
        ? "high"
        : (existing.quality ?? incoming.quality);
    // Non-speculative wins — if either side is first-hand, the merged quote is.
    const speculative =
      existing.speculative === true && incoming.speculative === true;
    return {
      id: existing.id ?? incoming.id,
      text,
      sentiment: existing.sentiment,
      ...(quality && { quality }),
      ...(speculative && { speculative: true }),
      ...(features.length > 0 && { features }),
      ...(useCases.length > 0 && { useCases }),
    };
  }

  private mergeEvidence(
    existing: Evidence[],
    incoming: Evidence[],
  ): Evidence[] {
    const byLabel = new Map(existing.map((e) => [e.label, e]));
    for (const evidence of incoming) {
      if (!byLabel.has(evidence.label)) {
        byLabel.set(evidence.label, evidence);
      }
    }
    return [...byLabel.values()];
  }

  /**
   * Whole-quote stance flag: speculative=true means the quote is hedged,
   * hearsay, or future-tense and excluded from sentiment voting / feature
   * aggregation. Quote.speculative is the authoritative stance — evidence
   * entries do not carry their own flag.
   */
  private isSpeculativeQuote(quote: Quote): boolean {
    return quote.speculative === true;
  }

  // ─── Details Aggregation ─────────────────────────────────────────────────────

  private aggregateDetails(
    contributions: ReviewContribution[],
  ): ReviewDetails | null {
    // Binary flags — OR across all contributing references. Weights don't apply.
    let returned = false;
    let defective = false;
    let multipleUnits = false;

    for (const { reference } of contributions) {
      const details = reference.referenceDetails;
      if (!details) continue;
      if (details.returned) returned = true;
      if (details.defective) defective = true;
      if (details.multipleUnits) multipleUnits = true;
    }

    if (!returned && !defective && !multipleUnits) return null;

    return {
      ...(returned ? { returned } : {}),
      ...(defective ? { defective } : {}),
      ...(multipleUnits ? { multipleUnits } : {}),
    };
  }

  // ─── Label Derivation ───────────────────────────────────────────────────────

  /**
   * Walk every contribution's quote-level AND ref-level evidence, grouping by
   * (type, normalized label), then collapse each group into a single
   * ReviewLabel via weighted consolidation (see `consolidateSentiment`). Per
   * the multi-candidate spec, each evidence weight is multiplied by the
   * contributing candidate's weight so a runner-up candidate's labels only
   * contribute fractionally to the consolidated sentiment.
   */
  private deriveLabels(
    review: Review,
    contributions: ReviewContribution[],
  ): ReviewLabel[] {
    const groups = new Map<
      string,
      { type: ReviewLabelType; label: string; entries: WeightedEntry[] }
    >();

    const { qualityWeights, refLevelQualityWeight, thresholds } =
      this.resolveLabelConsolidationConfig();

    const addEvidence = (
      type: ReviewLabelType,
      label: string,
      sentiment: Sentiment,
      qualityWeight: number,
    ): void => {
      const normalizedLabel = label.trim().toLowerCase();
      if (!normalizedLabel) return;
      const key = `${type}|${normalizedLabel}`;
      const entry = groups.get(key) ?? {
        type,
        label: normalizedLabel,
        entries: [],
      };
      entry.entries.push({ sentiment, qualityWeight });
      groups.set(key, entry);
    };

    for (const { reference, weight: candidateWeight } of contributions) {
      // Issue → parent-feature contribution: each closed-list issue on a
      // quote also counts as negative feature evidence under its declared
      // parent feature (per `IssueLabelConfig.feature` in the category
      // config), preserving the issue's severity. The original issue
      // evidence is still emitted separately as ReviewLabelType.Issue.
      const issueToFeature = this.buildIssueToFeatureMap(reference);

      // Quote-level evidence — walk every quote on every ref, not just review.quotes.
      // Low-quality quotes are excluded so they cannot single-handedly keep a
      // label alive that no other evidence supports.
      const contributingQuotes = (reference.quotes ?? []).filter(
        (quote) => !quote.speculative && quote.quality !== "low",
      );
      for (const quote of contributingQuotes) {
        const qWeight =
          qualityWeightOf(quote.quality, qualityWeights) * candidateWeight;
        for (const evidence of quote.features ?? []) {
          addEvidence(
            ReviewLabelType.Feature,
            evidence.label,
            effectiveSentiment(evidence, quote),
            qWeight,
          );
        }
        for (const evidence of quote.useCases ?? []) {
          addEvidence(
            ReviewLabelType.UseCase,
            evidence.label,
            effectiveSentiment(evidence, quote),
            qWeight,
          );
        }
        for (const evidence of quote.issues ?? []) {
          const severity = evidence.sentiment ?? Sentiment.Negative;
          addEvidence(ReviewLabelType.Issue, evidence.label, severity, qWeight);
          const parentFeature = issueToFeature.get(evidence.label);
          if (parentFeature) {
            addEvidence(
              ReviewLabelType.Feature,
              parentFeature,
              severity,
              qWeight,
            );
          }
        }
      }
      // Ref-level evidence — always confirmed (per STEP 6 of the labeling prompt).
      const refWeight = refLevelQualityWeight * candidateWeight;
      for (const evidence of reference.features ?? []) {
        addEvidence(
          ReviewLabelType.Feature,
          evidence.label,
          evidence.sentiment ?? Sentiment.Neutral,
          refWeight,
        );
      }
      for (const evidence of reference.useCases ?? []) {
        addEvidence(
          ReviewLabelType.UseCase,
          evidence.label,
          evidence.sentiment ?? Sentiment.Neutral,
          refWeight,
        );
      }
    }

    const labels: ReviewLabel[] = [];
    for (const { type, label, entries } of groups.values()) {
      const reviewLabel = new ReviewLabel();
      reviewLabel.review = review;
      reviewLabel.type = type;
      reviewLabel.label = label;
      reviewLabel.sentiment = consolidateSentiment(entries, thresholds);
      reviewLabel.evidenceCount = entries.length;
      labels.push(reviewLabel);
    }
    return labels;
  }

  /**
   * Build the `issueLabel → parentFeature` lookup for a ref's category.
   * Returns an empty map when the ref's category cannot be determined or
   * has no closed-list issues — callers should treat a missing entry as
   * "do not contribute to feature scoring".
   *
   * Normalised to lowercase keys so it composes with the lowercase
   * normalisation in `addEvidence`.
   */
  private buildIssueToFeatureMap(
    reference: ProductReference,
  ): Map<string, string> {
    // Use the reference's category directly. The ref's productCategory is the
    // identification-time category and matches the resolved product's
    // category in practice; falling back to it avoids a candidates-relation
    // walk during label derivation.
    const slug = reference.productCategory?.slug;
    const config = this.categoryConfigService.getConfig(slug);
    const map = new Map<string, string>();
    for (const issueLabel of getIssueLabels(config)) {
      map.set(issueLabel.label, issueLabel.feature);
    }
    return map;
  }

  private resolveLabelConsolidationConfig(): {
    qualityWeights: QualityWeights;
    refLevelQualityWeight: number;
    thresholds: LabelConsolidationThresholds;
  } {
    const overrides = this.dynamicConfig.scoring?.labelConsolidation;
    return {
      qualityWeights: {
        high: overrides?.qualityWeights?.high ?? DEFAULT_QUALITY_WEIGHTS.high,
        medium:
          overrides?.qualityWeights?.medium ?? DEFAULT_QUALITY_WEIGHTS.medium,
        low: overrides?.qualityWeights?.low ?? DEFAULT_QUALITY_WEIGHTS.low,
      },
      refLevelQualityWeight: overrides?.refLevelQualityWeight ?? 1.0,
      thresholds: {
        strongThreshold:
          overrides?.strongThreshold ??
          DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS.strongThreshold,
        positiveThreshold:
          overrides?.positiveThreshold ??
          DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS.positiveThreshold,
        minStrongMixed:
          overrides?.minStrongMixed ??
          DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS.minStrongMixed,
      },
    };
  }
}
