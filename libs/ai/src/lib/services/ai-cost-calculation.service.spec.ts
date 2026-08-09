import { AiPricingMap, AiUsage } from "@ebike-backend/ai-core";
import { AiCostCalculationService } from "./ai-cost-calculation.service";

describe("AiCostCalculationService", () => {
  let service: AiCostCalculationService;

  beforeEach(() => {
    service = new AiCostCalculationService();
  });

  const usage: AiUsage = {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    totalTokens: 2_000_000,
    cachedTokens: 500_000,
  };

  it("falls back to 50% of input rate when cachedInputPerMillion is not set", () => {
    const pricing: AiPricingMap = {
      "gpt-5.4-mini": { inputPerMillion: 1, outputPerMillion: 2 },
    };

    const cost = service.calculateAndAddUsage(
      "openai",
      "gpt-5.4-mini",
      pricing,
      "gpt-5.4-mini",
      undefined,
      usage,
    );

    // 0.5M non-cached input * $1 = $0.50
    // 0.5M cached input * $1 * 50% = $0.25
    // 1M output * $2 = $2.00
    // total = $2.75
    expect(cost).toBeCloseTo(2.75, 4);
  });

  it("uses cachedInputPerMillion when set", () => {
    const pricing: AiPricingMap = {
      "deepseek-v4-flash": {
        inputPerMillion: 0.14,
        cachedInputPerMillion: 0.0028,
        outputPerMillion: 0.28,
      },
    };

    const cost = service.calculateAndAddUsage(
      "deepseek",
      "deepseek-v4-flash",
      pricing,
      "deepseek-v4-flash",
      undefined,
      usage,
    );

    // 0.5M non-cached input * $0.14 = $0.07
    // 0.5M cached input * $0.0028 = $0.0014
    // 1M output * $0.28 = $0.28
    // total = $0.3514
    expect(cost).toBeCloseTo(0.3514, 4);
  });
});
