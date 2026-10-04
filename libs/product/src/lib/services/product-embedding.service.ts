import { Injectable } from '@nestjs/common';
import { AiEmbeddingService } from '@fittkereso-backend/ai';
import { compact } from 'lodash';

export interface ProductEmbeddingInput {
  brand: string | undefined;
  model: string | undefined;
  category: string | undefined;
}

@Injectable()
export class ProductEmbeddingService {
  constructor(private readonly embeddingService: AiEmbeddingService) {}

  /**
   * Build a brand-rich embedding input string and embed it.
   *
   * The embedding input is intentionally different from the matching key
   * (a listing's normalizedModel) — we want brand and category context in the
   * embedding so products of the same brand/category cluster together in
   * vector space, but the key brand-less so it compares model words alone.
   */
  public createProductEmbedding(
    input: ProductEmbeddingInput,
  ): Promise<number[]> {
    const text = compact([
      input.brand,
      input.model,
      input.category,
    ])
      .join(' ')
      .trim();

    return this.embeddingService.createEmbedding(text);
  }
}
