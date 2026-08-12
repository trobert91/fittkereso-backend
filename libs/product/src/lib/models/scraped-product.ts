import { ProductCategory, ProductSpecs } from '@fittkereso-backend/database';

export interface ScrapedProduct {
  category: ProductCategory;
  brand: string;
  model: string;
  displayName: string;
  aliases?: string[];
  releaseYear?: number;
  specs?: ProductSpecs;
  imageUrls?: string[];
}

export interface ScrapedProductSpec {
  name: string;
  sectionTitle?: string;
  description?: string;
  values?: string[];
}

export interface ProcessedProductSpec {
  name: string;
  value?: string;
  numericValue?: number;
}
