import {
  OfferAvailability,
  ProductCategory,
  ProductSpecs,
} from '@fittkereso-backend/database';

export interface ScrapedProduct {
  category: ProductCategory;
  brand: string;
  model: string;
  displayName: string;
  aliases?: string[];
  releaseYear?: number;
  specs?: ProductSpecs;
  imageUrls?: string[];
  offers?: ScrapedOffer[];
}

// Seller-listing data (price/availability/etc.) captured alongside a scraped
// product. Plumbing only for now — no extractor currently populates this;
// actual price-table scraping is future work.
export interface ScrapedOffer {
  sellerName: string;
  price: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  sourceListingId?: string;
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
