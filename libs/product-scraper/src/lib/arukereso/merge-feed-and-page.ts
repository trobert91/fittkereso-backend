import { defaults, isEmpty, isNil, omit, omitBy, pick } from 'lodash';
import type {
  ProductSpecs,
  ScrapedOffer,
  ScrapedPage,
  ScrapedPageOffer,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { splitDeterministicSpecs } from '../product-scraper/services/deterministic-specs';
import type { ProductPageRead } from '../product-scraper/services/product-page-reader.service';

/**
 * What a read of a feed listing's product page keeps (ScrapedProduct.page):
 * enough to merge it in again on every later feed-only import, without
 * fetching it. `rowCount` is how many of the feed's rows the page was read for.
 */
export function toScrapedPage(read: ProductPageRead, rowCount: number): ScrapedPage {
  const { detail } = read;
  const page: ScrapedPage = {
    url: read.url,
    rawSpecs: detail.rawSpecs,
    description: detail.description?.trim() || undefined,
    specs: read.specs && !isEmpty(read.specs) ? read.specs : undefined,
    images: detail.imageUrls.length
      ? detail.imageUrls.map((url, order) => ({ url, order }))
      : undefined,
    aliases: detail.aliases?.length ? detail.aliases : undefined,
    siblingExternalIds: detail.siblingIds,
    externalId: detail.externalId,
    offers: detail.rawOffers.length
      ? detail.rawOffers.map(
          (offer) =>
            omitBy(
              {
                externalId: offer.externalId,
                price: offer.price,
                priceWithoutDiscount: offer.priceWithoutDiscount,
                gtin: offer.gtin,
                mpn: offer.mpn,
                specs: offer.specs,
              },
              (value) => value === undefined,
            ) as ScrapedPageOffer,
        )
      : undefined,
    rowCount,
    contentHash: read.contentHash,
  };
  return omitBy(page, (value) => value === undefined) as unknown as ScrapedPage;
}

/**
 * A feed row with its product page merged in. **The feed is primary**: every
 * value the row has stays as the feed said it, and the page only fills what
 * the row lacks — a page read once must never switch a listing's category or
 * flip its price.
 *
 * - category, brand, title, url, externalId, price, availability, currency,
 *   condition: always the feed's.
 * - specs: every key the feed's mapping (and its brand/year folds) gave stays;
 *   the page's mapped specs fill the missing keys. Offer-level ones (size,
 *   colour) only when the page was read for this one row — a page several rows
 *   share (a bike's sizes) says nothing about one of them.
 * - rawSpecs: the feed's rows, then the page's, so the identity extraction and
 *   unification read both.
 * - description, images, aliases: the page's only when the row has none.
 *   Siblings only when the page's ids are the row's (its externalId matches).
 * - the row's offer: GTIN and MPN filled from the page offer that is this
 *   row's (by externalId, or the page's only offer on a one-row page); the old
 *   price only when the feed does not map one, and only while the feed price
 *   is still the price the page showed — an ended discount is never shown.
 *
 * Pure, and the same whether the page was just read or comes from the stored
 * record: a feed-only import after a page import gives the same listing.
 */
export function mergeFeedAndPage(
  listing: ScrapedProduct,
  page: ScrapedPage,
  offerLevelKeys: string[],
): ScrapedProduct {
  const pageSpecs = page.specs ?? {};
  const pageProductSpecs = omit(pageSpecs, offerLevelKeys);
  const pageOfferSpecs = page.rowCount === 1 ? pick(pageSpecs, offerLevelKeys) : {};
  const extractedSpecs: ProductSpecs = defaults(
    {},
    listing.extractedSpecs ?? {},
    pageProductSpecs,
    pageOfferSpecs,
  );
  const split = splitDeterministicSpecs(extractedSpecs, offerLevelKeys);

  const pageOffer = pageOfferOf(listing, page);
  const offers = listing.offers?.map((offer, index) =>
    index === 0 && pageOffer ? fillOfferGaps(offer, pageOffer) : offer,
  );

  return {
    ...listing,
    specs: split.productLevelDeterministicSpecs,
    extractedSpecs,
    offerLevelDeterministicSpecs: split.offerLevelDeterministicSpecs,
    productLevelDeterministicSpecs: split.productLevelDeterministicSpecs,
    offerSpecsHash: split.offerSpecsHash,
    productSpecsHash: split.productSpecsHash,
    rawSpecs: [...(listing.rawSpecs ?? []), ...page.rawSpecs],
    description: listing.description?.trim() ? listing.description : page.description,
    images: listing.images?.length ? listing.images : page.images,
    aliases: listing.aliases?.length ? listing.aliases : page.aliases,
    siblingExternalIds:
      listing.siblingExternalIds ??
      (page.externalId && page.externalId === listing.externalId ? page.siblingExternalIds : undefined),
    ...(offers ? { offers } : {}),
    page,
  };
}

/**
 * The page offer that is this row's: the one with the row's (or its offer's)
 * externalId, else — on a page read for this one row — its only offer. None
 * on a page of several rows where no id matches: which size is whose is
 * then unknown.
 */
function pageOfferOf(listing: ScrapedProduct, page: ScrapedPage): ScrapedPageOffer | undefined {
  const offers = page.offers ?? [];
  const ids = new Set(
    [listing.externalId, listing.offers?.[0]?.externalId]
      .map((id) => id?.toString().trim())
      .filter((id): id is string => !!id),
  );
  const byId = offers.filter((offer) => offer.externalId && ids.has(offer.externalId.trim()));
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return undefined;
  return page.rowCount === 1 && offers.length === 1 ? offers[0] : undefined;
}

/** The feed's offer, with what the page adds where the feed has nothing. */
function fillOfferGaps(offer: ScrapedOffer, pageOffer: ScrapedPageOffer): ScrapedOffer {
  const filled: ScrapedOffer = { ...offer };
  if (isNil(offer.gtin) && pageOffer.gtin) filled.gtin = pageOffer.gtin;
  if (isNil(offer.mpn) && pageOffer.mpn) filled.mpn = pageOffer.mpn;
  // `undefined`: the feed does not map an old price. `null` is the feed saying
  // there is none, which stands.
  if (
    offer.priceWithoutDiscount === undefined &&
    !isNil(pageOffer.priceWithoutDiscount) &&
    pageOffer.price === offer.price
  ) {
    filled.priceWithoutDiscount = pageOffer.priceWithoutDiscount;
  }
  return filled;
}
