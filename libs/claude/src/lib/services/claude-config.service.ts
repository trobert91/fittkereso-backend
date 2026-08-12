import { Injectable } from '@nestjs/common';
import { CLAUDE_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

@Injectable()
export class ClaudeConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get pricing(): Record<
    string,
    { inputPerMillion: number; outputPerMillion: number }
  > {
    return (
      this.dynamicConfig.claude?.pricing ??
      (CLAUDE_DEFAULTS.pricing as Record<
        string,
        { inputPerMillion: number; outputPerMillion: number }
      >)
    );
  }

  get maxRetries(): number {
    return this.dynamicConfig.claude?.maxRetries ?? CLAUDE_DEFAULTS.maxRetries;
  }

  get fallbackModel(): string {
    return (
      this.dynamicConfig.claude?.fallbackModel ?? CLAUDE_DEFAULTS.fallbackModel
    );
  }
}
