import { ProductSourceSyncMode } from "@ebike-backend/database";

export interface ThreadMessage {
  threadId: string;
}

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
