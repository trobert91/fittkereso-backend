import { ProductSource } from '@fittkereso-backend/database';

export interface ProductSourceSyncOptions {
  sourceTitles?: string[];
  brandNames?: string[];
}

export interface ProductSourceSyncService {
  sync(
    source: ProductSource,
    options?: ProductSourceSyncOptions,
  ): Promise<void>;
}
