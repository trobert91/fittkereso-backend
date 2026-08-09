import { Injectable } from "@nestjs/common";
import { AiEmbeddingService } from "@ebike-backend/ai";
import { compact } from "lodash";

export interface ProductEmbeddingInput {
  brand: string | undefined;
  model: string | undefined;
  displayName: string | undefined;
  category: string | undefined;
}

@Injectable()
export class ProductEmbeddingService {
  constructor(private readonly embeddingService: AiEmbeddingService) {}

  /**
   * Build a brand-rich embedding input string and embed it.
   *
   * The embedding input is intentionally different from the pg_trgm key
   * (ProductNormalizerService.normalizeProduct) — we want brand and category
   * context in the embedding so products of the same brand/category cluster
   * together in vector space, but we want the trigram key brand-less so
   * brand-less comment mentions match cleanly.
   */
  public createProductEmbedding(
    input: ProductEmbeddingInput,
  ): Promise<number[]> {
    const text = compact([
      input.brand,
      input.model ?? input.displayName,
      input.category,
    ])
      .join(" ")
      .trim();

    return this.embeddingService.createEmbedding(text);
  }
}
