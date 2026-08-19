import { ProductCategory } from '@fittkereso-backend/database';

export interface RuntimeDataProvider {
  getBrandNames(): Promise<string[]>;
  getCategoryBySlug(slug: string): Promise<ProductCategory | null>;
}
