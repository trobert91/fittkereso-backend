import { Injectable } from '@nestjs/common';
import {
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

/** A row identical to what its listing last imported, and the offer to refresh. */
export interface UnchangedFeedRow {
  row: FeedRow;
  offerId: string;
  modelId: string;
  lastSynced: Date | null;
}

export interface FeedTriage {
  /** Same row as last imported, and its offer exists: refresh the offer in place. */
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
 */
@Injectable()
export class ArukeresoFeedTriageService {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
  ) {}

  async triage(source: ProductSource, rows: FeedRow[]): Promise<FeedTriage> {
    const hashes = await this.sourceRecordRepo.findFeedRowHashes(
      source.id,
      rows.map((row) => row.url),
    );
    const sameRow = rows.filter(
      (row) => row.externalId && hashes.get(row.url) === row.rowHash,
    );
    const offers = await this.offerRepo.findSyncStates(
      source.seller.id,
      sameRow.map((row) => row.externalId as string),
    );
    const offerByExternalId = new Map(offers.map((offer) => [offer.externalId, offer]));

    const unchanged: UnchangedFeedRow[] = [];
    const toImport: FeedRow[] = [];
    for (const row of rows) {
      const offer =
        hashes.get(row.url) === row.rowHash && row.externalId
          ? offerByExternalId.get(row.externalId)
          : undefined;
      if (offer) {
        unchanged.push({
          row,
          offerId: offer.id,
          modelId: offer.modelId,
          lastSynced: offer.lastSynced,
        });
      } else {
        toImport.push(row);
      }
    }
    return { unchanged, toImport };
  }
}
