import {
  OfferAvailability,
  ProductCategory,
  ProductSpecs,
  ScrapedProductSpec,
} from '@fittkereso-backend/database';

// Re-exported for backward compatibility — callers importing ScrapedProductSpec
// from @fittkereso-backend/product keep working. The type itself now lives in
// @fittkereso-backend/database (see that lib's models/product-spec.ts) because
// ProductSourceRecord.rawSpecs needs it and database cannot depend on product.
export type { ScrapedProductSpec };

export interface ScrapedProduct {
  category: ProductCategory;
  brand: string;
  model: string;
  displayName: string;
  aliases?: string[];
  releaseYear?: number;
  specs?: ProductSpecs;
  rawSpecs?: ScrapedProductSpec[];
  externalId?: string;
  imageUrls?: string[];
  offers?: ScrapedOffer[];
}

// Seller-listing data (price/availability/etc.) captured alongside a scraped
// product, populated when a source's config defines detailPage.offers.
export interface ScrapedOffer {
  sellerName: string;
  price: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  sourceListingId?: string;
}

export interface ProcessedProductSpec {
  name: string;
  value?: string;
  numericValue?: number;
}
