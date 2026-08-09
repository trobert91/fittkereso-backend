import { Injectable } from "@nestjs/common";
import { GEMINI_DEFAULTS } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

@Injectable()
export class GeminiConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get pricing(): Record<
    string,
    { inputPerMillion: number; outputPerMillion: number }
  > {
    return (
      this.dynamicConfig.gemini?.pricing ??
      (GEMINI_DEFAULTS.pricing as Record<
        string,
        { inputPerMillion: number; outputPerMillion: number }
      >)
    );
  }

  get maxRetries(): number {
    return this.dynamicConfig.gemini?.maxRetries ?? GEMINI_DEFAULTS.maxRetries;
  }

  get fallbackModel(): string {
    return (
      this.dynamicConfig.gemini?.fallbackModel ?? GEMINI_DEFAULTS.fallbackModel
    );
  }
}
