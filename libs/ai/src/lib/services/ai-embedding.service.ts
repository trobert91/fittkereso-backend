import { Injectable } from '@nestjs/common';
import { AiProviderRegistry } from '@fittkereso-backend/ai-core';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

@Injectable()
export class AiEmbeddingService {
  constructor(private readonly registry: AiProviderRegistry) {}

  createEmbedding(input: string, model?: string): Promise<number[]> {
    const targetModel = model ?? DEFAULT_EMBEDDING_MODEL;
    const provider = this.registry.resolveEmbedding(targetModel);
    return provider.createEmbedding(input, targetModel);
  }

  createEmbeddings(inputs: string[], model?: string): Promise<number[][]> {
    const targetModel = model ?? DEFAULT_EMBEDDING_MODEL;
    const provider = this.registry.resolveEmbedding(targetModel);
    return provider.createEmbeddings(inputs, targetModel);
  }
}
