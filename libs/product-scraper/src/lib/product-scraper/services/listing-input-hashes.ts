import { createHash } from 'crypto';
import { isEmpty, omit, sortBy } from 'lodash';
import {
  ListingInputHashes,
  ListingInputPart,
  ListingPageRead,
  ProductSourceRecord,
  ProductSourceType,
  ProductSpecs,
  ScrapedProduct,
  ScrapedProductSpec,
  isFeedSourceType,
} from '@fittkereso-backend/database';
import { filterDefinedSpecs } from '@fittkereso-backend/utils';
import { stableStringify } from '../../arukereso/feed-row-hash';

/** The two sides a listing's input can come from: its feed row, and its product page. */
export type ListingInputSide = 'feed' | 'page';

/** What one side of a listing said: the input its hashes are taken over. */
export interface ListingInputPartData {
  brand?: string;
  title?: string;
  /** Its deterministic specs (a feed row's mapping, or the page rows mapped). */
  specs: ProductSpecs;
  rawSpecs: ScrapedProductSpec[];
  description?: string;
}

/** A listing's input by side, and the sides this import read. */
export interface ListingInputParts {
  feed?: ListingInputPartData;
  page?: ListingInputPartData;
  /** What this import read: the sides compared with, and written over, the stored hashes. */
  read: ListingInputSide[];
}

export const identityPartOf = (side: ListingInputSide): ListingInputPart =>
  side === 'feed' ? 'feedIdentity' : 'pageIdentity';

export const specsPartOf = (side: ListingInputSide): ListingInputPart =>
  side === 'feed' ? 'feedSpecs' : 'pageSpecs';

const whole = (listing: ScrapedProduct): ListingInputPartData => ({
  brand: listing.brand,
  title: listing.originalName,
  specs: listing.extractedSpecs ?? {},
  rawSpecs: listing.rawSpecs ?? [],
  description: listing.description,
});

/**
 * A listing's input by side.
 * - A scraped listing is its page, read now.
 * - A feed listing is its feed row (`feedListing`, the row as mapped before
 *   its page was merged in) and, when it has one, its page: read now when the
 *   import read it (`pageRead.fetchedAt`), else the page its record kept,
 *   merged in but not compared.
 */
export function inputPartsOf(
  listing: ScrapedProduct,
  context: {
    source: { type: ProductSourceType };
    feedListing?: ScrapedProduct;
    pageRead?: ListingPageRead;
  },
): ListingInputParts {
  if (!isFeedSourceType(context.source.type)) return { page: whole(listing), read: ['page'] };

  const feed = whole(context.feedListing ?? listing);
  const page =
    context.feedListing && listing.page
      ? {
          specs: listing.page.specs ?? {},
          rawSpecs: listing.page.rawSpecs ?? [],
          description: listing.page.description,
        }
      : undefined;
  return { feed, page, read: page && context.pageRead?.fetchedAt ? ['feed', 'page'] : ['feed'] };
}

/**
 * The hash of what spec unification reads from one side: its rows and mapped
 * values, and the category. Normalised so that only content counts — rows in
 * any order, any spacing — and without what never needs another unification:
 * offer-level values (a size, a colour) and the description.
 */
export function specsHashOf(
  part: ListingInputPartData,
  offerLevelKeys: string[],
  categorySlug: string,
): string {
  const clean = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const rows = sortBy(
    part.rawSpecs.map((row) => ({
      name: clean(row.name),
      section: row.sectionTitle ? clean(row.sectionTitle) : undefined,
      values: (row.values ?? []).map(clean),
    })),
    [(row) => row.name, (row) => row.section ?? '', (row) => row.values.join('\u0000')],
  );
  return sha256(
    stableStringify({
      category: categorySlug,
      rows,
      specs: filterDefinedSpecs(omit(part.specs, offerLevelKeys)),
    }),
  );
}

/**
 * The spec content a unification is made from: the feed's and the page's
 * spec hashes together. A side this import did not read counts as stored.
 */
export function specsKeyOf(hashes: ListingInputHashes): string {
  return sha256(stableStringify({ feed: hashes.feedSpecs ?? null, page: hashes.pageSpecs ?? null }));
}

/**
 * A listing's stored input hashes. A record from before the hashes were kept
 * by part has only scrapedProduct.identityInputHash, taken over the whole
 * input: that is its page's for a scraped listing, and its feed's for a feed
 * listing without a page (a feed listing's input was its feed alone). So an
 * unchanged listing still reuses its extraction after the change.
 */
export function storedInputHashesOf(
  record: Pick<ProductSourceRecord, 'inputHashes' | 'scrapedProduct'> | undefined,
  sourceType: ProductSourceType,
): ListingInputHashes {
  const stored = record?.inputHashes ?? {};
  if (!isEmpty(stored)) return stored;
  const legacy = record?.scrapedProduct?.identityInputHash;
  if (!legacy) return {};
  if (!isFeedSourceType(sourceType)) return { pageIdentity: legacy };
  return record?.scrapedProduct?.page ? {} : { feedIdentity: legacy };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
