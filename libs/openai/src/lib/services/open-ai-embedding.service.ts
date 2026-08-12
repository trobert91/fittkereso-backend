import { Injectable } from '@nestjs/common';
import { isEmpty } from 'lodash';
import { OpenAiClientService } from './open-ai-client.service';

@Injectable()
export class OpenAiEmbeddingService {
  constructor(private readonly openAiService: OpenAiClientService) {}

  /**
   * Generate an embedding vector for the given text input.
   * @param input The text to embed
   * @param model Optional embedding model (defaults to config or OpenAI text-embedding-3-small)
   *
   * IMPORTANT: Dimensions are explicitly set to 1536 to match DB schema (vector(1536)).
   * If changing this, you MUST migrate all existing embeddings and update the DB schema.
   */
  public async createEmbedding(
    input: string,
    model?: string,
  ): Promise<number[]> {
    if (!input || !input.trim()) {
      throw new Error('Input for embedding must be non-empty.');
    }

    const response = await this.openAiService.openAi.embeddings.create({
      model: model ?? 'text-embedding-3-small',
      input,
      dimensions: 1536, // CRITICAL: Must match product_embedding.embedding vector(1536)
    });

    // API always returns an array (since you can batch multiple inputs)
    const embedding = response.data[0].embedding;

    // Validate dimension to catch config errors early
    if (embedding.length !== 1536) {
      throw new Error(
        `Embedding dimension mismatch: expected 1536, got ${embedding.length}. ` +
          `This indicates a model configuration error that would cause database errors.`,
      );
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple inputs in a single API call.
   *
   * IMPORTANT: Dimensions are explicitly set to 1536 to match DB schema (vector(1536)).
   */
  public async createEmbeddings(
    inputs: string[],
    model?: string,
  ): Promise<number[][]> {
    if (isEmpty(inputs)) {
      throw new Error('At least one input is required for embeddings.');
    }

    const response = await this.openAiService.openAi.embeddings.create({
      model: model ?? 'text-embedding-3-small',
      input: inputs,
      dimensions: 1536, // CRITICAL: Must match product_embedding.embedding vector(1536)
    });

    const embeddings = response.data.map((d) => d.embedding);

    // Validate all dimensions
    embeddings.forEach((embedding, idx) => {
      if (embedding.length !== 1536) {
        throw new Error(
          `Embedding dimension mismatch at index ${idx}: expected 1536, got ${embedding.length}`,
        );
      }
    });

    return embeddings;
  }
}
