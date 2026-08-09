import { Module } from "@nestjs/common";
import { AiProviderRegistryModule } from "@ebike-backend/ai-core";
import { DebugModule } from "@ebike-backend/debug";
import { MetricsModule } from "@ebike-backend/metrics";
import { OpenAiModule } from "@ebike-backend/openai";
import { GeminiModule } from "@ebike-backend/gemini";
import { ClaudeModule } from "@ebike-backend/claude";
import { OpenRouterModule } from "@ebike-backend/openrouter";
import { DeepSeekModule } from "@ebike-backend/deepseek";
import { AiChatService } from "./services/ai-chat.service";
import { AiCostCalculationService } from "./services/ai-cost-calculation.service";
import { AiEmbeddingService } from "./services/ai-embedding.service";
import { AiSchemaValidatorService } from "./services/ai-schema-validator.service";

@Module({
  imports: [
    AiProviderRegistryModule,
    DebugModule,
    MetricsModule,
    OpenAiModule,
    GeminiModule,
    ClaudeModule,
    OpenRouterModule,
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
    OpenRouterModule,
    DeepSeekModule,
    AiProviderRegistryModule,
  ],
})
export class AiModule {}
