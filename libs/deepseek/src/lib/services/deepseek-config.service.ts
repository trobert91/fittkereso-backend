import { Injectable } from '@nestjs/common';
import { DEEPSEEK_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ModelPricing } from '@fittkereso-backend/ai-core';

@Injectable()
export class DeepSeekConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get pricing(): Record<string, ModelPricing> {
    return (
      this.dynamicConfig.deepseek?.pricing ??
      (DEEPSEEK_DEFAULTS.pricing as Record<string, ModelPricing>)
    );
  }

  get maxRetries(): number {
    return (
      this.dynamicConfig.deepseek?.maxRetries ?? DEEPSEEK_DEFAULTS.maxRetries
    );
  }

  get fallbackModel(): string {
    return (
      this.dynamicConfig.deepseek?.fallbackModel ??
      DEEPSEEK_DEFAULTS.fallbackModel
    );
  }
}
