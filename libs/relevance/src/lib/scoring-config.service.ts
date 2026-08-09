import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { SCORING_DEFAULTS } from "@ebike-backend/config";

@Injectable()
export class ScoringConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get quoteScoring() {
    const overrides = this.dynamicConfig.scoring?.quoteScoring;
    const defaults = SCORING_DEFAULTS.quoteScoring;
    return {
      positiveNegativeRoleScore:
        overrides?.positiveNegativeRoleScore ??
        defaults.positiveNegativeRoleScore,
      neutralRoleScore:
        overrides?.neutralRoleScore ?? defaults.neutralRoleScore,
      lowInfoPenalty: overrides?.lowInfoPenalty ?? defaults.lowInfoPenalty,
      lowInfoMinLength:
        overrides?.lowInfoMinLength ?? defaults.lowInfoMinLength,
      phraseScoreMultiplier:
        overrides?.phraseScoreMultiplier ?? defaults.phraseScoreMultiplier,
      lengthFactorDivisor:
        overrides?.lengthFactorDivisor ?? defaults.lengthFactorDivisor,
      quoteCountLogBase:
        overrides?.quoteCountLogBase ?? defaults.quoteCountLogBase,
      quoteBlendWeight:
        overrides?.quoteBlendWeight ?? defaults.quoteBlendWeight,
      expectedMax: overrides?.expectedMax ?? defaults.expectedMax,
      fuzzyThreshold: overrides?.fuzzyThreshold ?? defaults.fuzzyThreshold,
    };
  }

  get textScoring() {
    const overrides = this.dynamicConfig.scoring?.textScoring;
    const defaults = SCORING_DEFAULTS.textScoring;
    return {
      expectedMax: overrides?.expectedMax ?? defaults.expectedMax,
    };
  }

  get deliberation() {
    const overrides = this.dynamicConfig.scoring?.deliberation;
    const defaults = SCORING_DEFAULTS.deliberation;
    return {
      fuzzyThreshold: overrides?.fuzzyThreshold ?? defaults.fuzzyThreshold,
      phraseBoostMultiplier:
        overrides?.phraseBoostMultiplier ?? defaults.phraseBoostMultiplier,
      saturationDivisor:
        overrides?.saturationDivisor ?? defaults.saturationDivisor,
      maxMultiplierBoost:
        overrides?.maxMultiplierBoost ?? defaults.maxMultiplierBoost,
    };
  }

  get categoryRelevance() {
    const overrides = this.dynamicConfig.scoring?.categoryRelevance;
    const defaults = SCORING_DEFAULTS.categoryRelevance;
    return {
      topKeywordCount: overrides?.topKeywordCount ?? defaults.topKeywordCount,
      fuzzyThreshold: overrides?.fuzzyThreshold ?? defaults.fuzzyThreshold,
      categoryNameWeight:
        overrides?.categoryNameWeight ?? defaults.categoryNameWeight,
      categoryAliasWeight:
        overrides?.categoryAliasWeight ?? defaults.categoryAliasWeight,
      keywordIdentifierWeight:
        overrides?.keywordIdentifierWeight ?? defaults.keywordIdentifierWeight,
      phraseBoostBase: overrides?.phraseBoostBase ?? defaults.phraseBoostBase,
      /** Minimum floor for the per-term reference match count used to compute the normalization target. */
      referenceMatchesPerTerm:
        overrides?.referenceMatchesPerTerm ?? defaults.referenceMatchesPerTerm,
      /** Reference per-term weight used by the normalization target. */
      referenceWeightPerTerm:
        overrides?.referenceWeightPerTerm ?? defaults.referenceWeightPerTerm,
      /** Divisor for scaling expected match count with corpus size — a category needs roughly `corpus/divisor` matches per term to fully saturate. */
      referenceCorpusDivisor:
        overrides?.referenceCorpusDivisor ?? defaults.referenceCorpusDivisor,
      /** Additive bonus per matched exclusive term, applied on the 0-1 scale before negative penalty. */
      exclusiveTermBoost:
        overrides?.exclusiveTermBoost ?? defaults.exclusiveTermBoost,
      /** Floor for the cumulative negative-term penalty (prevents score collapsing to zero). */
      negativeTermFloor:
        overrides?.negativeTermFloor ?? defaults.negativeTermFloor,
    };
  }

  get priorityConfig() {
    const overrides = this.dynamicConfig.scoring?.priorityConfig;
    const defaults = SCORING_DEFAULTS.priorityConfig;
    return {
      distanceDecay: overrides?.distanceDecay ?? defaults.distanceDecay,
      relevanceWeight: overrides?.relevanceWeight ?? defaults.relevanceWeight,
      mentionWeight: overrides?.mentionWeight ?? defaults.mentionWeight,
      recencyBoostEnabled:
        overrides?.recencyBoostEnabled ?? defaults.recencyBoostEnabled,
      recencyBoost24h: overrides?.recencyBoost24h ?? defaults.recencyBoost24h,
      recencyBoost7d: overrides?.recencyBoost7d ?? defaults.recencyBoost7d,
      parentPriorityRelevanceBlend:
        overrides?.parentPriorityRelevanceBlend ??
        defaults.parentPriorityRelevanceBlend,
      relativeBoostMinRatio:
        overrides?.relativeBoostMinRatio ?? defaults.relativeBoostMinRatio,
      relativeBoostTarget:
        overrides?.relativeBoostTarget ?? defaults.relativeBoostTarget,
    };
  }
}
