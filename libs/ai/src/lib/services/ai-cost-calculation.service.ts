import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiPricingMap, AiProviderName, AiUsage } from "@ebike-backend/ai-core";

@Injectable()
export class AiCostCalculationService {
  private logger = new CustomLogger(AiCostCalculationService.name);

  private costSum = 0;

  /**
   * Compute the cost in USD for a single chat call. Cached input tokens are
   * billed at the model's `cachedInputPerMillion` rate when set, otherwise at
   * 50% of `inputPerMillion` (legacy default; harmless for Gemini since
   * cachedTokens defaults to 0 there).
   *
   * Returns undefined when no usage info is available.
   */
  public calculateAndAddUsage(
    provider: AiProviderName,
    model: string,
    pricing: AiPricingMap,
    fallbackModel: string,
    costLabel: string | undefined,
    usage: AiUsage | undefined,
  ): number | undefined {
    if (!usage) {
      return undefined;
    }

    const modelPricing = pricing[model] ?? pricing[fallbackModel];
    if (!modelPricing) {
      this.logger.warn(
        `No pricing configured for model "${model}" (provider=${provider}, fallback="${fallbackModel}"). Cost = 0.`,
      );
      return 0;
    }

    const inputPricePerMillion = modelPricing.inputPerMillion;
    const outputPricePerMillion = modelPricing.outputPerMillion;
    const cachedPricePerMillion =
      modelPricing.cachedInputPerMillion ?? inputPricePerMillion * 0.5;

    const inputTokens = usage.promptTokens ?? 0;
    const outputTokens = usage.completionTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;
    const nonCachedInputTokens = inputTokens - cachedTokens;

    const cost =
      (nonCachedInputTokens / 1_000_000) * inputPricePerMillion +
      (cachedTokens / 1_000_000) * cachedPricePerMillion +
      (outputTokens / 1_000_000) * outputPricePerMillion;

    this.costSum += cost;

    this.logger.debug(
      `AI token usage [${provider}:${model}]${costLabel ? ` (${costLabel})` : ""}: ${inputTokens} input (${cachedTokens} cached) + ${outputTokens} output = $${cost.toFixed(4)}, $${this.costSum.toFixed(4)} since service started`,
    );

    return cost;
  }
}
