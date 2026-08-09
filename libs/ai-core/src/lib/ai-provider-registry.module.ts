import { Global, Module } from '@nestjs/common';
import { AiProviderRegistry } from './services/ai-provider-registry.service';

/**
 * Standalone module that owns the singleton `AiProviderRegistry`.
 * Marked `@Global()` so provider modules (libs/openai, libs/gemini) and
 * the orchestrator (libs/ai) all see the same instance — providers must
 * register into the same registry that `AiChatService` consults.
 *
 * Lives in its own module to avoid an import cycle: provider modules
 * depend on this module; AiModule depends on the provider modules.
 */
@Global()
@Module({
  providers: [AiProviderRegistry],
  exports: [AiProviderRegistry],
})
export class AiProviderRegistryModule {}
