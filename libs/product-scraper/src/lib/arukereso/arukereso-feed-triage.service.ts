import { Injectable } from '@nestjs/common';
import {
  FeedRowState,
  OfferRepository,
  ProductSource,
  ProductSourceRecordRepository,
  isArukeresoConfig,
} from '@fittkereso-backend/database';
import type { ScrapedProduct } from '@fittkereso-backend/product';
import { listingExternalIdOf, offerExternalIdOf } from '@fittkereso-backend/utils';
import type { ArukeresoFeedItem } from './arukereso-feed-item';
import { feedRowHash } from './feed-row-hash';
import {
  detailRefreshDueAt,
  detailRefreshIntervalMs,
} from '../product-scraper/services/detail-refresh-schedule';

/**
 * How long after reading a row's page failed for good (every attempt of its
 * task) the page is left alone: a broken or vanished page is not fetched on
 * every nightly run, and the row is imported from the feed alone meanwhile.
 */
export const PAGE_RETRY_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

/** One mapped feed row, ready to triage. */
export interface FeedRow {
  /** Canonical product URL: where the listing's offer links, and its task's key. */
  url: string;
  /**
   * The key of the listing's record (listingExternalIdOf): the row's
   * externalId, else its URL slug. What its record is found by, so a row
   * whose URL changed still finds it.
   */
  listingId: string;
  item: ArukeresoFeedItem;
  scrapedProduct: ScrapedProduct;
  /** feedRowHash of the mapped row. */
  rowHash: string;
  /** The externalId its offer is stored under (offerExternalIdOf). */
  externalId?: string;
}

/** A mapped feed row's keys and hash, the same for a run and its simulation. */
export function toFeedRow(
  mapped: { url: string; scrapedProduct: ScrapedProduct },
  item: ArukeresoFeedItem,
): FeedRow {
  const offer = mapped.scrapedProduct.offers?.[0];
  return {
    url: mapped.url,
    listingId: listingExternalIdOf(mapped.scrapedProduct, mapped.url),
    item,
    scrapedProduct: mapped.scrapedProduct,
    rowHash: feedRowHash(mapped.url, mapped.scrapedProduct),
    externalId: offer ? offerExternalIdOf(offer, mapped.url).value : undefined,
  };
}

/**
 * A row identical to what its listing last imported, and the offer to
 * refresh. The offer fields are absent for a contributing source's row that
 * waits unattached: there is no offer to refresh, only the listing to stamp.
 */
export interface UnchangedFeedRow {
  row: FeedRow;
  offerId?: string;
  modelId?: string;
  lastSynced?: Date | null;
  /** When this source last listed it, before this run. */
  recordSeenAt: Date;
}

export interface FeedTriage {
  /** Same row as last imported, and nothing to attach or detach: confirm it in place. */
  unchanged: UnchangedFeedRow[];
  /** New, changed, missing its offer, or due for its page: a task imports it. */
  toImport: FeedRow[];
  /**
   * The listing ids among toImport whose product page is to be read with
   * them (the source has a detailPage): new rows — page first — and rows whose
   * page was never read or is due by detailRefreshInterval. Such a row is
   * imported even when it is unchanged.
   */
  needsPage: Set<string>;
}

/**
 * Sorts a batch of mapped feed rows into those a run only has to confirm and
 * those it has to import. Read-only: the feed run acts on the answer, and the
 * import simulator reports it.
 *
 * A row is unchanged when its listing's stored feedRowHash equals the row's,
 * AND the listing's offer still exists. The listing is found by its key, and
 * the hash covers the URL: a row whose URL changed is imported again, which
 * moves the record to it. The second half matters: a listing
 * whose offer was swept, or whose import failed after the record was written,
 * has nothing to refresh and must be imported again.
 *
 * A source that does not identify products never creates the offer, so for
 * its rows the second half is whether the listing sits where the offer is: on
 * the offer's product, or unattached while the seller has no such offer. A
 * listing that waits while the offer now exists, or sits on a product the
 * offer has left, is imported again and joins or leaves accordingly.
 */
@Injectable()
export class ArukeresoFeedTriageService {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
  ) {}

  async triage(source: ProductSource, rows: FeedRow[], now = new Date()): Promise<FeedTriage> {
    const states = await this.sourceRecordRepo.findFeedRowStates(
      source.id,
      rows.map((row) => row.listingId),
    );
    const isSameRow = (row: FeedRow) =>
      !!row.externalId && states.get(row.listingId)?.feedRowHash === row.rowHash;
    const offers = await this.offerRepo.findSyncStates(
      source.seller.id,
      rows.filter(isSameRow).map((row) => row.externalId as string),
    );
    const offerByExternalId = new Map(offers.map((offer) => [offer.externalId, offer]));

    const unchanged: UnchangedFeedRow[] = [];
    const toImport: FeedRow[] = [];
    const needsPage = new Set<string>();
    const pageDue = this.pageDue(source, now);
    for (const row of rows) {
      const state = states.get(row.listingId);
      if (pageDue(row, state)) {
        needsPage.add(row.listingId);
        toImport.push(row);
        continue;
      }
      if (!state || !isSameRow(row)) {
        toImport.push(row);
        continue;
      }
      const offer = offerByExternalId.get(row.externalId as string);
      const holds =
        source.identifiesProducts === false
          ? this.sitsWhereItsOfferIs(state, offer)
          : !!offer;
      if (!holds) {
        toImport.push(row);
      } else if (offer) {
        unchanged.push({
          row,
          offerId: offer.id,
          modelId: offer.modelId,
          lastSynced: offer.lastSynced,
          recordSeenAt: state.seenAt,
        });
      } else {
        unchanged.push({ row, recordSeenAt: state.seenAt });
      }
    }
    return { unchanged, toImport, needsPage };
  }

  /**
   * Whether a row's product page is to be read with it: only for a source
   * with a detailPage. A new row is read page first. A known row's page is
   * read when it never was, or once due by detailRefreshInterval ('once':
   * never again) — but not within PAGE_RETRY_BACKOFF_MS of its last failure.
   */
  private pageDue(
    source: ProductSource,
    now: Date,
  ): (row: FeedRow, state: FeedRowState | undefined) => boolean {
    const readsPages = isArukeresoConfig(source.config) && !!source.config.detailPage;
    if (!readsPages) return () => false;
    const intervalMs = detailRefreshIntervalMs(source);

    return (row, state) => {
      if (!state) return true;
      if (state.pageFailedAt && now.getTime() - state.pageFailedAt.getTime() < PAGE_RETRY_BACKOFF_MS) {
        return false;
      }
      if (!state.pageFetchedAt) return true;
      const dueAt = detailRefreshDueAt({ url: row.url, lastUpdated: state.pageFetchedAt, intervalMs });
      return !!dueAt && now > dueAt;
    };
  }

  /** A contributing listing on its offer's product, or unattached with no offer to join. */
  private sitsWhereItsOfferIs(
    state: FeedRowState,
    offer: { modelId: string } | undefined,
  ): boolean {
    return offer ? state.modelId === offer.modelId : state.modelId === null;
  }
}
