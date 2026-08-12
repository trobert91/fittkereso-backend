import { ProductSourceSyncMode } from '@fittkereso-backend/database';

export interface ProductMessage {
  productId: string;
}

export interface ProductSourceSyncMessage {
  productSourceId: string;
  syncMode?: ProductSourceSyncMode;
  categoryIds?: string[];
  brandNames?: string[];
}

export interface ProductReviewAnalysisMessage {
  productId: string;
}
