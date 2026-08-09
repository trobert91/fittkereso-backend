import { AiProviderName } from './ai-provider-name';

export interface AiEmbeddingProvider {
  readonly name: AiProviderName;
  supports(model: string): boolean;
  createEmbedding(input: string, model?: string): Promise<number[]>;
  createEmbeddings(inputs: string[], model?: string): Promise<number[][]>;
}
