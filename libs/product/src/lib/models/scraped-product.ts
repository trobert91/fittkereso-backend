// Re-exported for backward compatibility — callers importing ScrapedProduct/
// ScrapedProductSpec/ScrapedOffer from @fittkereso-backend/product keep
// working. The types themselves now live in @fittkereso-backend/database
// (see that lib's models/scraped-product.ts and models/product-spec.ts)
// because ProductSourceRecord.scrapedProduct/.rawSpecs need them and
// database cannot depend on product.
export type {
  ScrapedProduct,
  ScrapedOffer,
  ScrapedProductSpec,
} from '@fittkereso-backend/database';

export interface ProcessedProductSpec {
  name: string;
  value?: string;
  numericValue?: number;
}
