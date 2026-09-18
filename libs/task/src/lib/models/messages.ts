export interface ProductMessage {
  productId: string;
}

export interface ProductSourceSyncMessage {
  productSourceId: string;
  categoryIds?: string[];
  brandNames?: string[];
}

export interface ProductReviewAnalysisMessage {
  productId: string;
}
