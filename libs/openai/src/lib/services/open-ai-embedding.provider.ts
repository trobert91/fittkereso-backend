import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  AiEmbeddingProvider,
  AiProviderRegistry,
} from "@ebike-backend/ai-core";
import { OpenAiEmbeddingService } from "./open-ai-embedding.service";

@Injectable()
export class OpenAiEmbeddingProvider
  implements AiEmbeddingProvider, OnModuleInit
{
  readonly name = "openai" as const;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly embeddingService: OpenAiEmbeddingService,
  ) {}

  onModuleInit(): void {
    this.registry.registerEmbedding(this);
  }

  supports(model: string): boolean {
    return /^text-embedding-/.test(model);
  }

  createEmbedding(input: string, model?: string): Promise<number[]> {
    return this.embeddingService.createEmbedding(input, model);
  }

  createEmbeddings(inputs: string[], model?: string): Promise<number[][]> {
    return this.embeddingService.createEmbeddings(inputs, model);
  }
}
