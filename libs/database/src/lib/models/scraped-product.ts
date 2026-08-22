import { ProductSpecs, ScrapedProductSpec } from './product-spec';
import { OfferAvailability } from '../postgres/types/offer-availability';

/**
 * The complete result of scraping one product listing from one source,
 * before persistence. Stored verbatim on ProductSourceRecord.scrapedProduct
 * (see that entity) as the pre-resolution source claim, so
 * brand/model/displayName/aliases/releaseYear/imageUrls/offers/specs/
 * rawSpecs can all be reprocessed without a re-scrape. Lives in
 * @fittkereso-backend/database (not @fittkereso-backend/product, which
 * re-exports it) for the same reason as ScrapedProductSpec: database cannot
 * depend on product.
 *
 * `category` is intentionally a lightweight reference, not the full
 * ProductCategory entity — nothing reads more than id/slug/name off it, and
 * a full entity reference would duplicate/go-stale-with the category table
 * once this whole object is persisted verbatim.
 */
export interface ScrapedProduct {
  category: { id: string; slug: string; name: string };
  brand: string;
  model: string;
  displayName: string;
  /**
   * The raw, unfiltered title/model text exactly as scraped, before
   * ProductSourcePostProcessService (or the post-process-disabled path)
   * strips brand/marketing/size/color boilerplate into the clean `model`
   * above. Some sources (e.g. speedbike.hu) only expose the full marketing
   * title, so this is the only place the original listing name survives.
   */
  originalName?: string;
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
  /**
   * The pre-discount price, only set when the source shows this offer as
   * currently discounted (e.g. a struck-through original price alongside
   * the current one). Absent when the offer isn't on discount.
   */
  priceWithoutDiscount?: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  sourceListingId?: string;
  /**
   * Offer-level spec values (e.g. frameSize, color) for this specific
   * listing — overrides the page-level offer-level specs derived from
   * ProductSourceRecord.specs when a source reports multiple size/color
   * variants on a single product page, each with its own price. Optional:
   * most sources have nothing to put here and rely on the page-level default.
   */
  specs?: ProductSpecs;
}
