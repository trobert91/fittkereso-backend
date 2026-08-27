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
  /**
   * Output of SpecExtractionService.extractSpecs — the deterministic,
   * label-matching spec mapping before ProductSourcePostProcessService's LLM
   * pass merges its own contribution on top to produce `specs` above. This is
   * also exactly the `deterministicSpecs` payload sent to the LLM (see
   * ProductSourcePostProcessService.buildUserMessage), kept here so a source
   * record shows both what was deterministically extracted and what the LLM
   * changed, without needing a re-scrape to compare. Undefined whenever
   * `specs` is undefined (offerSpecsHash/productSpecsHash-unchanged skip, or
   * no specMapping configured for the category).
   */
  extractedSpecs?: ProductSpecs;
  /**
   * `filterDefinedSpecs(pick(extractedSpecs, offerLevelSpecs))` — the
   * offer-level subset of the deterministic mapping, computed once in
   * ProductDetailsPageScraperService.extractProduct and reused for: (a) the
   * offer-identity post-process call's input, (b) offerSpecsHash below (see
   * hashSpecs/filterDefinedSpecs in @fittkereso-backend/utils). Persisted
   * here rather than recomputed at each read site, so hashing/LLM-input/
   * persistence all agree on exactly the same, already-filtered object.
   * Undefined under the same conditions as `extractedSpecs`.
   */
  offerLevelDeterministicSpecs?: ProductSpecs;
  /**
   * `filterDefinedSpecs(omit(extractedSpecs, offerLevelSpecs))` — the
   * complement of `offerLevelDeterministicSpecs`. Feeds the model-spec
   * post-process call's input and productSpecsHash below. See
   * offerLevelDeterministicSpecs for why this is computed once and
   * persisted rather than re-derived per read.
   */
  productLevelDeterministicSpecs?: ProductSpecs;
  /**
   * `hashSpecs(offerLevelDeterministicSpecs)`, computed once alongside it in
   * ProductDetailsPageScraperService.extractProduct.
   * ProductSourceRecordUpdaterService persists this value as given rather
   * than re-hashing, so the hash used for the same-record skip decision and
   * the hash actually stored on ProductSourceRecord.offerSpecsHash are
   * always identical by construction.
   */
  offerSpecsHash?: string;
  /**
   * `hashSpecs(productLevelDeterministicSpecs)` — see offerSpecsHash. Also
   * the value ultimately compared against sibling records by
   * ProductSourceRecordRepository.findBySourceAndProductSpecsHash, so a
   * mismatch between the hash used to decide vs. the hash persisted would
   * silently defeat that cache — see productSpecsHash's history for why this
   * must be computed exactly once and threaded through unchanged.
   */
  productSpecsHash?: string;
  rawSpecs?: ScrapedProductSpec[];
  externalId?: string;
  imageUrls?: string[];
  offers?: ScrapedOffer[];
}

// Seller-listing data (price/availability/etc.) captured alongside a scraped
// product, populated when a source's config defines detailPage.offers.
export interface ScrapedOffer {
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
  externalId?: string;
  /**
   * Store/warehouse names where this offer is physically available (e.g.
   * ["Törökbálinti raktár", "Törökbálint"]). Optional — most sources have no
   * per-location breakdown.
   */
  locations?: string[];
  /**
   * Offer-level spec values (e.g. frameSize, color) for this specific
   * listing — overrides the page-level offer-level specs derived from
   * ProductSourceRecord.specs when a source reports multiple size/color
   * variants on a single product page, each with its own price. Optional:
   * most sources have nothing to put here and rely on the page-level default.
   */
  specs?: ProductSpecs;
}
