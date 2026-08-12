import { Module } from '@nestjs/common';
import { AiProviderRegistryModule } from '@fittkereso-backend/ai-core';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { OpenAiModule } from '@fittkereso-backend/openai';
import { GeminiModule } from '@fittkereso-backend/gemini';
import { ClaudeModule } from '@fittkereso-backend/claude';
import { DeepSeekModule } from '@fittkereso-backend/deepseek';
import { AiChatService } from './services/ai-chat.service';
import { AiCostCalculationService } from './services/ai-cost-calculation.service';
import { AiEmbeddingService } from './services/ai-embedding.service';
import { AiSchemaValidatorService } from './services/ai-schema-validator.service';

@Module({
  imports: [
    AiProviderRegistryModule,
    MetricsModule,
    OpenAiModule,
    GeminiModule,
    ClaudeModule,
    DeepSeekModule,
  ],
  providers: [
    AiCostCalculationService,
    AiSchemaValidatorService,
    AiChatService,
    AiEmbeddingService,
  ],
  exports: [
    AiCostCalculationService,
    AiSchemaValidatorService,
    AiChatService,
    AiEmbeddingService,
    OpenAiModule,
    GeminiModule,
    ClaudeModule,
    DeepSeekModule,
    AiProviderRegistryModule,
  ],
})
export class AiModule {}
