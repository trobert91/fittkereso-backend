import { Injectable } from '@nestjs/common';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';

/**
 * Threshold + weight knobs the matcher and quality gates consult.
 *
 * All score-comparison fields are on the unified 0–100 integer scale (same as
 * the matcher's output and the persisted context). The decision LLM's
 * `acceptThreshold` lives separately under `dynamicConfig.search`.
 */
export interface MatchingConfig {
  acceptThreshold: number;
  acceptThresholdStrict: number;
  ambiguityGap: number;
  defaultStrictness: 'strict' | 'moderate' | 'loose';
  defaultNumericTokenWeight: number;
  ambiguityGapAnchored: number;
}

@Injectable()
export class MatchingConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get config(): MatchingConfig {
    const overrides = this.dynamicConfig.resolution?.matching;
    const defaults = RESOLUTION_DEFAULTS.matching;
    return {
      acceptThreshold: overrides?.acceptThreshold ?? defaults.acceptThreshold,
      acceptThresholdStrict:
        overrides?.acceptThresholdStrict ?? defaults.acceptThresholdStrict,
      ambiguityGap: overrides?.ambiguityGap ?? defaults.ambiguityGap,
      defaultStrictness: (overrides?.defaultStrictness ??
        defaults.defaultStrictness) as 'strict' | 'moderate' | 'loose',
      defaultNumericTokenWeight:
        overrides?.defaultNumericTokenWeight ??
        defaults.defaultNumericTokenWeight,
      ambiguityGapAnchored:
        (overrides as Record<string, number> | undefined)?.[
          'ambiguityGapAnchored'
        ] ?? 10,
    };
  }
}
