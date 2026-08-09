export interface ModelPricing {
  inputPerMillion: number;
  /**
   * Per-million-token price for cached input tokens. When absent, the cost
   * service falls back to 50% of inputPerMillion (legacy OpenAI default).
   * DeepSeek and OpenAI gpt-5 use much steeper cache discounts — set this
   * explicitly for those.
   */
  cachedInputPerMillion?: number;
  outputPerMillion: number;
}

export type AiPricingMap = Record<string, ModelPricing>;
