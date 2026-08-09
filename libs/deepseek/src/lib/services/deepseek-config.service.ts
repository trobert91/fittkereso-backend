import { Injectable } from "@nestjs/common";
import { DEEPSEEK_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ModelPricing } from "@ebike-backend/ai-core";

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
