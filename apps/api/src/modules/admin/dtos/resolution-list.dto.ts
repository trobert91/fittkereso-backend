import { ProductResolution } from '@fittkereso-backend/database';
import type {
  ProductResolutionState,
  ProductSourceRecord,
  ScrapedOffer,
} from '@fittkereso-backend/database';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { Expose, Transform, Type } from 'class-transformer';
import { minBy } from 'lodash';

/**
 * The scraped listing, reduced to what a reviewer compares against the product
 * it was matched to.
 *
 * A projection rather than the raw `ScrapedProduct`: that blob carries every
 * spec variant, `rawSpecs` and the marketing description, which is far too much
 * to ship for every row of a paginated queue — and it is exposed only to
 * `adminDetails`, so the list view cannot see it at all.
 */
export class ResolutionListingSummary {
  @Expose({ groups: [SerializeGroup.adminList] })
  brand?: string;

  /** The raw listing title, before brand/marketing boilerplate was stripped
   *  into `model`. Only some sources expose one. */
  @Expose({ groups: [SerializeGroup.adminList] })
  originalName?: string;

  /** The cleaned name, so the card still has something to show when the source
   *  has no `originalName`. */
  @Expose({ groups: [SerializeGroup.adminList] })
  displayName?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  url?: string;

  /** Order 0 is the listing's primary image. */
  @Expose({ groups: [SerializeGroup.adminList] })
  imageUrl?: string;

  /** From the cheapest scraped offer — the same rule `recomputePrice` uses to
   *  denormalize `ProductModel.price`, so the two are comparable. */
  @Expose({ groups: [SerializeGroup.adminList] })
  price?: number;

  /** That same offer's pre-discount price; absent when it is not discounted. */
  @Expose({ groups: [SerializeGroup.adminList] })
  priceWithoutDiscount?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  currency?: string;

  /** How many offers the listing carried, so a single price is not mistaken
   *  for the whole picture on a multi-variant page. */
  @Expose({ groups: [SerializeGroup.adminList] })
  offerCount?: number;

  static from(
    record?: ProductSourceRecord | null,
  ): ResolutionListingSummary | undefined {
    const scraped = record?.scrapedProduct;
    if (!record || !scraped) return undefined;

    const offers = scraped.offers ?? [];
    // Match ProductModel.price's rule — cheapest offer wins — so a reviewer
    // comparing the two numbers is comparing like with like.
    const cheapest = minBy(offers, (offer: ScrapedOffer) => offer.price);
    const primaryImage = minBy(scraped.images ?? [], (image) => image.order);

    const summary = new ResolutionListingSummary();
    summary.brand = scraped.brand;
    summary.originalName = scraped.originalName;
    summary.displayName = scraped.displayName;
    summary.url = record.url ?? cheapest?.url;
    summary.imageUrl = primaryImage?.url;
    summary.price = cheapest?.price;
    summary.priceWithoutDiscount = cheapest?.priceWithoutDiscount;
    summary.currency = cheapest?.currency;
    summary.offerCount = offers.length;

    return summary;
  }
}

/**
 * One review-queue row plus what can be done to it, so the client never has to
 * re-derive the rules the backend enforces.
 *
 * This is a class rather than an interface on purpose. The API serializes with
 * `strategy: 'excludeAll'` (see `apps/api/src/app.ts`), under which
 * class-transformer only emits properties carrying `@Expose` metadata on a known
 * target type — a plain object literal has no target type, so every key is
 * dropped and the response comes back as `{}`.
 */
export class ResolutionListItem {
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ProductResolution)
  resolution: ProductResolution;

  /** Derived rather than persisted, so it is a plain object and needs the same
   *  exposeAll transform the entity's jsonb columns use. */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  state: ProductResolutionState;

  /** The scraped listing side of the comparison, projected out of the
   *  `scrapedProduct` blob so the queue can render it without carrying it. */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ResolutionListingSummary)
  listing?: ResolutionListingSummary;

  /**
   * `productId => imageUrl` for the row's candidates.
   *
   * The stored candidate holds a `candidateId` and no entity data, so without
   * this the queue can name a candidate but not show it. A plain map rather than
   * hydrated products: the card needs a picture, and shipping a full
   * `ProductModel` per candidate would put the review payload back into a
   * paginated list.
   *
   * An id missing from the map has no picture to show — deleted product, or no
   * image on it.
   */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  candidateImageUrls?: Record<string, string>;

  static of(
    resolution: ProductResolution,
    state: ProductResolutionState,
    candidateImageUrls?: Record<string, string>,
  ): ResolutionListItem {
    const item = new ResolutionListItem();
    item.resolution = resolution;
    item.state = state;
    item.listing = ResolutionListingSummary.from(resolution.sourceRecord);
    item.candidateImageUrls = candidateImageUrls;
    return item;
  }
}

/** A page of review-queue rows. Mirrors `BasePageResult`, which lives inside
 *  `libs/search` and is not exported from its barrel. */
export class ResolutionListResult {
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ResolutionListItem)
  items: ResolutionListItem[];

  @Expose({ groups: [SerializeGroup.list] })
  page: number;

  @Expose({ groups: [SerializeGroup.list] })
  pageSize: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalItems: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalPages: number;
}
