export interface BaseTraceData {
  summary: string;
  decision?: {
    action: string;
    reason: string;
  };
  error?: {
    message: string;
    stack?: string;
  };
}

export type ProcessingTraceData = ProductSimilarityTraceData;

export interface ProductSimilarityTraceData extends BaseTraceData {
  similarity: {
    query: {
      model: string;
      displayName?: string;
      aliasCount: number;
      hasSpecs: boolean;
      year?: number;
    };
    candidate: {
      model: string;
      displayName?: string;
      aliasCount: number;
      hasSpecs: boolean;
      releaseYear?: number;
    };
    brandName?: string;
    categorySlug?: string;
    result: {
      score: number;
      nameBase: number;
      criticalNumericPenalty: number;
      suffixDiscriminatorPenalty: number;
      specPenalty: number;
      bestMatchName: string;
      components: {
        stringSimilarity: number;
        tokenOverlap: number;
        alphaMatch: number;
        aliasMatch: boolean;
        specSimilarity: number;
      };
      specMatchDetails?: unknown;
    };
  };
}
