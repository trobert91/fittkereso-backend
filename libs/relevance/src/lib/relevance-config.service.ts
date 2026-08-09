import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { RELEVANCE_DEFAULTS } from "@ebike-backend/config";

export interface ExperienceTierConfig {
  multiplier: number;
  floor: number;
}

export interface ExperienceConfig {
  owner: ExperienceTierConfig;
  priorOwner: ExperienceTierConfig;
  tested: ExperienceTierConfig;
  prospectiveBuyer: ExperienceTierConfig;
  reference: ExperienceTierConfig;
}

export interface QuoteQualityWeights {
  high: number;
  medium: number;
  low: number;
}

export interface RelevanceScoringConfig {
  fuzzyThreshold: number;
  productTermCap: number;
  searchSimilarityThreshold: number;
  quoteQualityWeights: QuoteQualityWeights;
  experienceConfig: ExperienceConfig;
}

type ExperienceTier = keyof ExperienceConfig;

const EXPERIENCE_TIERS: ExperienceTier[] = [
  "owner",
  "priorOwner",
  "tested",
  "prospectiveBuyer",
  "reference",
];

@Injectable()
export class RelevanceConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get config(): RelevanceScoringConfig {
    const overrides = this.dynamicConfig.relevance;
    return {
      fuzzyThreshold:
        overrides?.fuzzyThreshold ?? RELEVANCE_DEFAULTS.fuzzyThreshold,
      productTermCap:
        overrides?.productTermCap ?? RELEVANCE_DEFAULTS.productTermCap,
      searchSimilarityThreshold:
        overrides?.searchSimilarityThreshold ??
        RELEVANCE_DEFAULTS.searchSimilarityThreshold,
      quoteQualityWeights: this.mergeQuoteQualityWeights(
        overrides?.quoteQualityWeights,
      ),
      experienceConfig: this.mergeExperienceConfig(overrides?.experienceConfig),
    };
  }

  private mergeQuoteQualityWeights(overrides?: {
    high?: number;
    medium?: number;
    low?: number;
  }): QuoteQualityWeights {
    const defaults = RELEVANCE_DEFAULTS.quoteQualityWeights;
    return {
      high: overrides?.high ?? defaults.high,
      medium: overrides?.medium ?? defaults.medium,
      low: overrides?.low ?? defaults.low,
    };
  }

  private mergeExperienceConfig(
    overrides?: Record<string, { multiplier?: number; floor?: number }>,
  ): ExperienceConfig {
    const defaults = RELEVANCE_DEFAULTS.experienceConfig;
    const result = {} as ExperienceConfig;

    for (const tier of EXPERIENCE_TIERS) {
      const defaultTier = defaults[tier];
      const overrideTier = overrides?.[tier];
      result[tier] = {
        multiplier: overrideTier?.multiplier ?? defaultTier.multiplier,
        floor: overrideTier?.floor ?? defaultTier.floor,
      };
    }

    return result;
  }
}
