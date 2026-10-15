import { ProductSpecs, ScrapedProductSpec } from './product-spec';
import { OfferAvailability } from '../postgres/types/offer-availability';
import { OfferCondition } from '../postgres/types/offer-condition';

/**
 * The complete result of scraping one product listing from one source,
 * before persistence. Stored verbatim on ProductSourceRecord.scrapedProduct
 * (see that entity) as the pre-resolution source claim, so
 * brand/model/aliases/images/offers/specs/
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
  /**
   * The model name the identity extraction read off the title: the title's
   * own words that tell this model apart from the brand's others — line,
   * model numbers, variant and equipment markers — without the brand and
   * without the values of the specs the category's `matchingConfig.model`
   * leaves out (size, colour, year, ...). What the product is shown as, and,
   * normalized (ProductMatchQueryService.normalizedModelOf), what its listings
   * are matched on. Set only when that call returned one (now, or on an
   * earlier import whose result was reused); otherwise absent, and `flags`
   * says why. A reader that needs some name either way takes listingModel().
   */
  model?: string;
  /**
   * Digest of what `model` was asked under: the category's left-out specs,
   * its examples and the prompt's version. A stored model under another
   * contract is extracted again, alone — the rest of the stored extraction
   * (its specs) is kept.
   */
  modelContract?: string;
  /**
   * The title exactly as the shop publishes it. Every importer sets it; the
   * identity extraction reads it, and it stays as scraped.
   */
  originalName: string;
  /**
   * What happened to this listing on its import that its fields alone don't
   * show — why it has no `model`, say. Rebuilt on every import: the importers
   * set none, the updater's steps add theirs.
   */
  flags?: ScrapedProductFlag[];
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
  /**
   * A feed listing's product page as last read (the source's `detailPage`):
   * what it said, kept so every later feed-only import merges it in again
   * without fetching it. The feed is primary — these only fill what the row
   * lacks (mergeFeedAndPage). Absent on a feed listing whose page was never
   * read, and on scraped listings, whose page is the listing itself.
   */
  page?: ScrapedPage;
  /**
   * This import's input hashes, by part — handed from the post-process step
   * to the record write, which merges them into
   * ProductSourceRecord.inputHashes. Not kept in the stored JSON.
   */
  inputHashes?: ListingInputHashes;
  /**
   * What the listing was identified by when its product was last decided
   * (ListingIdentityKey). A later import whose key differs is checked
   * against its product, and identified again if it no longer fits. Absent
   * on records written before it existed: their key is read off the record.
   */
  identityKey?: ListingIdentityKey;
}

/**
 * What decides which product a listing is: its brand, its normalizedModel,
 * its identifiers and its category's primary and matcher specs. A title
 * reworded without changing these leaves it equal.
 */
export interface ListingIdentityKey {
  /** The definition it was made under; a key of another is read off the record again. */
  version: number;
  /** The brand as the listing names it, normalized. */
  brand: string;
  normalizedModel: string | null;
  /** Each sorted, in stored form (GTIN-14, normalized MPN). */
  gtins: string[];
  mpns: string[];
  siblingIds: string[];
  /** The category's primarySpecs and matcherSpecs the listing states. */
  specs: ProductSpecs;
}

/**
 * The parts a listing's input is hashed in (ProductSourceRecord.inputHashes):
 * - `feedIdentity` / `pageIdentity`: what the identity extraction would be
 *   given from the feed row, and from the product page;
 * - `feedSpecs` / `pageSpecs`: what spec unification reads from each — the
 *   rows and mapped values, normalised, without offer-level values or the
 *   description;
 * - `unifiedSpecs`: the feed + page specs the stored unification output was
 *   made from.
 * An import compares only the parts it read: a feed-only import its feed's,
 * a page import both, a scraping import its page's. A part it did not read
 * keeps its stored hash.
 */
export const LISTING_INPUT_PARTS = [
  'feedIdentity',
  'pageIdentity',
  'feedSpecs',
  'pageSpecs',
  'unifiedSpecs',
] as const;
export type ListingInputPart = (typeof LISTING_INPUT_PARTS)[number];
export type ListingInputHashes = Partial<Record<ListingInputPart, string>>;

/** What a feed listing's product page said (ScrapedProduct.page). */
export interface ScrapedPage {
  /** The URL it was read from. */
  url: string;
  rawSpecs: ScrapedProductSpec[];
  description?: string;
  /** The rows mapped onto the category's specs when the page was read, before any fold. */
  specs?: ProductSpecs;
  images?: ProductSourceImage[];
  aliases?: string[];
  siblingExternalIds?: string[];
  /** The page's own id, when its detailPage reads one. */
  externalId?: string;
  /** The offers the page showed: only their identifiers and old price are ever used. */
  offers?: ScrapedPageOffer[];
  /**
   * How many feed rows the page was read for. A page several rows share
   * (a bike's sizes) says nothing about one of them: its offer-level values
   * are then left out.
   */
  rowCount: number;
  /** pageContentHash: its rows and description. */
  contentHash: string;
}

/**
 * A feed listing's page bookkeeping, as an import writes it onto the record
 * (ProductSourceRecord.pageFetchedAt / pageFailedAt): read now — `fetchedAt`,
 * with `failedAt` cleared — or failed for good, `failedAt`.
 */
export interface ListingPageRead {
  fetchedAt?: Date;
  failedAt?: Date | null;
}

/** One offer a feed listing's page showed (ScrapedPage.offers). */
export interface ScrapedPageOffer {
  externalId?: string;
  price?: number;
  priceWithoutDiscount?: number | null;
  gtin?: string | null;
  mpn?: string | null;
  specs?: ProductSpecs;
}

/**
 * The flags a listing can carry (ScrapedProduct.flags):
 * - `identity_off`: its source's `postProcess.identity` is off, so no identity
 *   extraction ran and it has no `model`.
 * - `identity_failed`: the extraction ran but returned no model (an LLM error,
 *   a truncated or empty answer). The next import calls it again.
 */
export const SCRAPED_PRODUCT_FLAGS = ['identity_off', 'identity_failed'] as const;
export type ScrapedProductFlag = (typeof SCRAPED_PRODUCT_FLAGS)[number];

/**
 * The name to use where some name is needed whether or not the listing was
 * identified — a new product's shell, say: the model, else the shop's title.
 */
export function listingModel(scrapedProduct: Pick<ScrapedProduct, 'model' | 'originalName'>): string {
  return scrapedProduct.model ?? scrapedProduct.originalName;
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
  /**
   * New, used or refurbished. Null when the source maps it and this item's
   * value is empty or not one of the three, which reads as new: a shop marks
   * the exceptions, as Google Shopping's spec has it. Absent when the source
   * does not map it.
   */
  condition?: OfferCondition | null;
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
