import { Injectable } from "@nestjs/common";
import { OPENROUTER_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

@Injectable()
export class OpenRouterConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get pricing(): Record<
    string,
    { inputPerMillion: number; outputPerMillion: number }
  > {
    return (
      this.dynamicConfig.openrouter?.pricing ??
      (OPENROUTER_DEFAULTS.pricing as Record<
        string,
        { inputPerMillion: number; outputPerMillion: number }
      >)
    );
  }

  get maxRetries(): number {
    return (
      this.dynamicConfig.openrouter?.maxRetries ??
      OPENROUTER_DEFAULTS.maxRetries
    );
  }

  get fallbackModel(): string {
    return (
      this.dynamicConfig.openrouter?.fallbackModel ??
      OPENROUTER_DEFAULTS.fallbackModel
    );
  }
}
