import { ProductSourceConfig } from '@fittkereso-backend/database';

export interface ProductSourceUpdateParams {
  name?: string;
  sellerId?: string;
  config?: ProductSourceConfig;
  schedulingEnabled?: boolean;
  processingEnabled?: boolean;
  priority?: number;
  maxConcurrent?: number;
  requestsPerHour?: number;
  fullSyncInterval?: string | null;
  incrementalSyncInterval?: string | null;
  nextFullSyncAt?: string | null;
  nextIncrementalSyncAt?: string | null;
}
