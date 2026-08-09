import { AiPricingMap } from './ai-pricing.interface';

/**
 * Per-provider configuration the orchestrator needs to read at call time.
 * Implemented by each provider's *ConfigService and exposed via the registry.
 */
export interface AiProviderConfig {
  pricing: AiPricingMap;
  fallbackModel: string;
  maxRetries: number;
  debug: boolean;
}
