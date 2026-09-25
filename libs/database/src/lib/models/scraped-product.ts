import { ProductSpecs, ScrapedProductSpec } from './product-spec';
import { OfferAvailability } from '../postgres/types/offer-availability';

/**
 * The complete result of scraping one product listing from one source,
 * before persistence. Stored verbatim on ProductSourceRecord.scrapedProduct
 * (see that entity) as the pre-resolution source claim, so
 * brand/model/displayName/aliases/images/offers/specs/
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
   * identity extraction's input, (b) offerSpecsHash below (see
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
   * `hashSpecs(productLevelDeterministicSpecs)` — see offerSpecsHash. A
   * mismatch between the hash used to decide and the hash persisted would
   * silently defeat the re-import skip, which is why it is computed exactly
   * once and threaded through unchanged.
   */
  productSpecsHash?: string;
  rawSpecs?: ScrapedProductSpec[];
  /**
   * Free-text marketing/description copy from the listing, when the
   * source's config extracts one — see ProductSourceDetailPageConfig.
   * Persisted alongside rawSpecs for the same reason: lets the model-spec
   * LLM contribution be inspected/reprocessed without a re-scrape.
   */
  description?: string;
  externalId?: string;
  /**
   * The other sizes of this product, as the shop itself declares them (e.g.
   * ebikeshop's frame-size variation list), in the same id space as
   * `externalId`. May include this listing's own id.
   *
   * Only ever compared within this listing's own source: a shop's grouping
   * is authoritative for its own ids and says nothing about another shop's.
   * Absent for a source that declares none — deliberately not derived from
   * article-number prefixes or shared images, which were measured to group
   * different bikes together.
   */
  siblingExternalIds?: string[];
  /**
   * Whether `model` came back from the LLM identity extraction, rather than
   * being the raw title because the call was skipped or failed. A raw title
   * carries sizes, colours and marketing words, so ProductNameMergeService
   * lets it vote on a product's name only when no cleaned name exists.
   */
  nameCleaned?: boolean;
  /**
   * Hash of exactly what the identity extraction was given — the raw title,
   * the brand, the deterministic identity values and the selected spec rows.
   * A re-import whose hash (and both spec hashes) match the stored record's
   * reuses that record's extraction instead of calling the LLM again.
   *
   * Needed beside offerSpecsHash/productSpecsHash because those only cover the
   * deterministic mapping: on a source whose mapping fills a single field, a
   * changed title or spec table would otherwise never be re-read.
   */
  identityInputHash?: string;
  images?: ProductSourceImage[];
  offers?: ScrapedOffer[];
}

// A single scraped image URL with its position in the source listing's
// gallery/pipeline output order — order 0 is the listing's primary image.
export interface ProductSourceImage {
  url: string;
  order: number;
}

// Seller-listing data (price/availability/etc.) captured alongside a scraped
// product, populated when a source's config defines detailPage.offers.
//
// A field speaks for its source only when present. `null` means the source
// maps the field and has no value for this item (a sale that ended clears the
// old price); an absent key means the source does not map it at all, so the
// seller's other sources decide it (OfferComposerService). Entries stored
// before this distinction only carry keys for real values, so an absent key
// reads as silent there too.
export interface ScrapedOffer {
  price: number;
  /**
   * The pre-discount price, only set when the source shows this offer as
   * currently discounted (e.g. a struck-through original price alongside
   * the current one). Null when the source maps it and the offer isn't
   * discounted.
   */
  priceWithoutDiscount?: number | null;
  currency?: string | null;
  availability?: OfferAvailability | null;
  url?: string | null;
  externalId?: string;
  /**
   * The `Offer.externalId` this entry is stored under, after the page-wide
   * collision guard (ProductScrapeUpdaterService.resolveOfferExternalIds).
   * Set on the copy kept in ProductSourceRecord.scrapedProduct, so a seller's
   * records join its offers without re-deriving it. Null on an entry whose id
   * collided with another on its page (its offer has no externalId); absent on
   * entries stored before it existed.
   */
  resolvedExternalId?: string | null;
  /**
   * The barcode exactly as the source published it (EAN-13, UPC-12, or
   * whatever the shop put in that field). Normalized and validated only when
   * written to Offer.gtin, so an invalid value stays inspectable here.
   */
  gtin?: string | null;
  /**
   * The manufacturer's article number exactly as the source published it,
   * after the source config's own clean-up. Normalized when written to
   * Offer.mpn.
   */
  mpn?: string | null;
  /**
   * Store/warehouse names where this offer is physically available (e.g.
   * ["Törökbálinti raktár", "Törökbálint"]). Optional — most sources have no
   * per-location breakdown.
   */
  locations?: string[] | null;
  /**
   * Offer-level spec values (e.g. frameSize, color) for this specific
   * listing — overrides the page-level offer-level specs derived from
   * ProductSourceRecord.specs when a source reports multiple size/color
   * variants on a single product page, each with its own price. Optional:
   * most sources have nothing to put here and rely on the page-level default.
   * The copy stored on a record carries that default when the offer had none.
   */
  specs?: ProductSpecs;
}
