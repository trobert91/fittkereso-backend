import { Injectable } from '@nestjs/common';
import {
  FeedRowState,
  OfferRepository,
  ProductSource,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import type { ScrapedProduct } from '@fittkereso-backend/product';
import type { ArukeresoFeedItem } from './arukereso-feed-item';

/** One mapped feed row, ready to triage. */
export interface FeedRow {
  /** Canonical product URL: the listing's identity within its source. */
  url: string;
  item: ArukeresoFeedItem;
  scrapedProduct: ScrapedProduct;
  /** feedRowHash of the mapped row. */
  rowHash: string;
  /** The externalId its offer is stored under (offerExternalIdOf). */
  externalId?: string;
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
  /** New, changed, or missing its offer: a feed_entry task imports it. */
  toImport: FeedRow[];
}

/**
 * Sorts a batch of mapped feed rows into those a run only has to confirm and
 * those it has to import. Read-only: the feed run acts on the answer, and the
 * import simulator reports it.
 *
 * A row is unchanged when its listing's stored feedRowHash equals the row's,
 * AND the listing's offer still exists. The second half matters: a listing
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

  async triage(source: ProductSource, rows: FeedRow[]): Promise<FeedTriage> {
    const states = await this.sourceRecordRepo.findFeedRowStates(
      source.id,
      rows.map((row) => row.url),
    );
    const isSameRow = (row: FeedRow) =>
      !!row.externalId && states.get(row.url)?.feedRowHash === row.rowHash;
    const offers = await this.offerRepo.findSyncStates(
      source.seller.id,
      rows.filter(isSameRow).map((row) => row.externalId as string),
    );
    const offerByExternalId = new Map(offers.map((offer) => [offer.externalId, offer]));

    const unchanged: UnchangedFeedRow[] = [];
    const toImport: FeedRow[] = [];
    for (const row of rows) {
      const state = states.get(row.url);
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
    return { unchanged, toImport };
  }

  /** A contributing listing on its offer's product, or unattached with no offer to join. */
  private sitsWhereItsOfferIs(
    state: FeedRowState,
    offer: { modelId: string } | undefined,
  ): boolean {
    return offer ? state.modelId === offer.modelId : state.modelId === null;
  }
}
