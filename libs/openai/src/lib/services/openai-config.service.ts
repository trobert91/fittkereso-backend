import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { OPENAI_DEFAULTS } from "@ebike-backend/config";

@Injectable()
export class OpenAiConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get pricing(): Record<
    string,
    { inputPerMillion: number; outputPerMillion: number }
  > {
    return (
      this.dynamicConfig.openai?.pricing ??
      (OPENAI_DEFAULTS.pricing as Record<
        string,
        { inputPerMillion: number; outputPerMillion: number }
      >)
    );
  }

  get maxRetries(): number {
    return this.dynamicConfig.openai?.maxRetries ?? OPENAI_DEFAULTS.maxRetries;
  }
}
