import { Injectable } from "@nestjs/common";
import {
  collectAllFeatures,
  collectAllUseCases,
  Depth,
  ExperienceType,
  Intent,
  isNegativeSentiment,
  isPositiveSentiment,
  ProductCategory,
  ProductReference,
  Quote,
  RelevanceFactors,
  Sentiment,
} from "@ebike-backend/database";
import {
  ExperienceTierConfig,
  RelevanceConfigService,
} from "../relevance-config.service";
import { isEmpty } from "lodash";

export interface ReferenceRelevanceResult {
  score: number;
  factors: RelevanceFactors;
}

const DETAILED_OR_ABOVE = new Set<Depth>([Depth.Comprehensive, Depth.Detailed]);
const HANDS_ON_EXPERIENCE = new Set<ExperienceType>([
  ExperienceType.Owner,
  ExperienceType.PriorOwner,
  ExperienceType.Tested,
]);
const DEFAULT_EXPERIENCE: ExperienceTierConfig = { multiplier: 0.85, floor: 0 };

@Injectable()
export class ReferenceRelevanceService {
  constructor(private readonly relevanceConfig: RelevanceConfigService) {}
  private readonly DEPTH_MULTIPLIERS: Record<Depth, number> = {
    [Depth.Comprehensive]: 1.0,
    [Depth.Detailed]: 0.75,
    [Depth.Mentioned]: 0.45,
    [Depth.Superficial]: 0.1,
  };

  private readonly FIRSTHAND_INTENT_MULTIPLIERS: Partial<
    Record<Intent, number>
  > = {
    [Intent.SeekingAdvice]: 0.5,
    [Intent.Question]: 0.7,
    [Intent.ReputationReport]: 0.85,
  };

  private readonly SECONDHAND_INTENT_MULTIPLIERS: Partial<
    Record<Intent, number>
  > = {
    [Intent.SeekingAdvice]: 0.3,
    [Intent.Question]: 0.5,
    [Intent.ReputationReport]: 0.5,
    [Intent.Comparison]: 0.7,
  };

  private readonly SENTIMENT_MULTIPLIERS: Record<Sentiment, number> = {
    [Sentiment.StrongPositive]: 1.0,
    [Sentiment.Positive]: 1.0,
    [Sentiment.Negative]: 1.0,
    [Sentiment.StrongNegative]: 1.0,
    [Sentiment.Mixed]: 1.0,
    [Sentiment.Neutral]: 0.85,
  };

  private get experienceConfig(): Record<ExperienceType, ExperienceTierConfig> {
    const config = this.relevanceConfig.config.experienceConfig;
    return {
      [ExperienceType.Owner]: config.owner,
      [ExperienceType.PriorOwner]: config.priorOwner,
      [ExperienceType.Tested]: config.tested,
      [ExperienceType.ProspectiveBuyer]: config.prospectiveBuyer,
      [ExperienceType.Reference]: config.reference,
    };
  }

  /**
   * Quote quality is best-evidence-wins (max weight across the ref's quotes), with a small
   * volume bump when there are multiple high-quality quotes: 2 high → ×1.05, 3+ high → ×1.10.
   * Only `high` quotes count toward volume; medium/low quotes don't bump the multiplier.
   */
  public calculateRelevance(
    ref: ProductReference,
    _category: ProductCategory | undefined,
    _commentBody?: string,
    upvotes?: number,
  ): ReferenceRelevanceResult {
    const depthMultiplier =
      this.DEPTH_MULTIPLIERS[ref.depth ?? Depth.Mentioned] ?? 0.5;

    // Combined view: ref-level LLM emits + per-quote evidence (non-speculative).
    // Both directions of feature sentiment count toward volume — relevance is
    // about evidence density, not polarity. Mirrors the previous
    // positiveFeatures + negativeFeatures sum.
    const allFeatures = collectAllFeatures(ref);
    const featureCount = allFeatures.filter(
      (e) =>
        isPositiveSentiment(e.sentiment) || isNegativeSentiment(e.sentiment),
    ).length;

    const hasOtherSignals =
      featureCount > 0 ||
      DETAILED_OR_ABOVE.has(ref.depth as Depth) ||
      HANDS_ON_EXPERIENCE.has(ref.experience as ExperienceType);

    const quoteQualityMultiplier = this.calculateQuoteQualityMultiplier(
      ref.quotes ?? [],
      hasOtherSignals,
    );

    const sentimentMultiplier =
      this.SENTIMENT_MULTIPLIERS[ref.sentiment ?? Sentiment.Neutral] ?? 0.85;

    const featureMultiplier = 0.85 + 0.35 * (1 - Math.exp(-featureCount * 0.6));

    const useCaseCount = collectAllUseCases(ref).length;
    const useCaseMultiplier = 1.0 + 0.15 * (1 - Math.exp(-useCaseCount * 0.7));

    const featureUseCaseMultiplier = Math.min(
      1.2,
      featureMultiplier * useCaseMultiplier,
    );

    const intentMultiplier = this.calculateIntentMultiplier(
      ref.intents ?? [],
      ref.experience as ExperienceType,
    );

    const contentScore =
      depthMultiplier *
      quoteQualityMultiplier *
      sentimentMultiplier *
      featureUseCaseMultiplier *
      intentMultiplier *
      85;

    const upvoteBoost = Math.min(0.3, 0.0874 * Math.log(1 + (upvotes ?? 0)));
    const boostedContentScore = contentScore * (1 + upvoteBoost);

    const experience =
      this.experienceConfig[ref.experience ?? ExperienceType.Reference] ??
      DEFAULT_EXPERIENCE;

    return {
      score: Math.round(
        Math.min(
          100,
          Math.max(
            1,
            boostedContentScore * experience.multiplier + experience.floor,
          ),
        ),
      ),
      factors: {
        depthMultiplier,
        quoteQualityMultiplier,
        sentimentMultiplier,
        experienceMultiplier: experience.multiplier,
        experienceFloorBonus: experience.floor,
        featureMultiplier,
        useCaseMultiplier,
        featureUseCaseMultiplier,
        intentMultiplier,
        upvoteBoost,
      },
    };
  }

  // ─── Programmatic Factors ──────────────────────────────────────────────────

  private calculateQuoteQualityMultiplier(
    quotes: Quote[],
    hasOtherSignals: boolean,
  ): number {
    const weights = this.relevanceConfig.config.quoteQualityWeights;
    if (isEmpty(quotes)) {
      return hasOtherSignals ? weights.low : 0;
    }
    const baseMax = Math.max(
      ...quotes.map((quote) => weights[quote.quality ?? "medium"]),
    );
    const highCount = quotes.filter((quote) => quote.quality === "high").length;
    const volumeBump = highCount >= 3 ? 1.1 : highCount === 2 ? 1.05 : 1.0;
    return baseMax * volumeBump;
  }

  private calculateIntentMultiplier(
    intents: Intent[],
    experience?: ExperienceType,
  ): number {
    if (intents.length === 0) return 1.0;

    const isFirsthand = HANDS_ON_EXPERIENCE.has(experience as ExperienceType);
    const multiplierTable = isFirsthand
      ? this.FIRSTHAND_INTENT_MULTIPLIERS
      : this.SECONDHAND_INTENT_MULTIPLIERS;

    let highest = 0.0;
    for (const intent of intents) {
      const multiplier = multiplierTable[intent] ?? 1.0;
      if (multiplier > highest) {
        highest = multiplier;
      }
    }
    return highest;
  }
}
