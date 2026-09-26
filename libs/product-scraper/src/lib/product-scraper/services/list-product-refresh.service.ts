import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  ProductModelRepository,
  ProductSource,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapedListProduct,
  ScrapedOffer,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  OFFER_COMPOSER_MODEL_RELATIONS,
  OfferComposerService,
  ProductMergeService,
} from '@fittkereso-backend/product';
import { normalizeUrl, storedOfferExternalId } from '@fittkereso-backend/utils';
import { isEmpty } from 'lodash';
import { detailRefreshDueAt, detailRefreshIntervalMs } from './detail-refresh-schedule';

/**
 * The fields required by default before a list card may stand in for a detail
 * scrape. Overridable via `import.listRefreshRequiredFields`.
 */
export const DEFAULT_LIST_REFRESH_REQUIRED_FIELDS = [
  'url',
  'price',
  'availability',
];

export type ListItemOutcome =
  /** Refreshed in place — no detail fetch spent. */
  | 'refreshed'
  /** Known listing, but the card was too thin; detail scrape needed. */
  | 'incomplete'
  /**
   * Known listing whose last detail import is older than the source's
   * detailRefreshInterval allows: fetched in full again for what a card never
   * shows (a new GTIN, specs, description, stores).
   */
  | 'stale'
  /** Not seen before; only a detail page has its specs, brand and model. */
  | 'unknown'
  /**
   * Known by its externalId under another URL, while another record of this
   * source already holds the card's URL: a detail scrape sorts that out, where
   * moving the listing would be a guess.
   */
  | 'moved'
  /** Known listing with no offer row to refresh yet. */
  | 'no_offer';

export const LIST_ITEM_OUTCOMES: readonly ListItemOutcome[] = [
  'refreshed',
  'incomplete',
  'stale',
  'unknown',
  'moved',
  'no_offer',
];

/** A zero count per outcome, for a page's or a run's split. */
export function emptyOutcomeCounts(): Record<ListItemOutcome, number> {
  return Object.fromEntries(
    LIST_ITEM_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<ListItemOutcome, number>;
}

/** What a run does with one card, decided without writing anything. */
export interface ListItemDecision {
  /**
   * `refresh` where the card refreshes its listing in place. That write can
   * still find no offer to compose onto, and then reports `no_offer`.
   */
  outcome: Exclude<ListItemOutcome, 'refreshed'> | 'refresh';
  /** This source's record of the listing, when it has one. */
  record?: ProductSourceRecord;
  /**
   * The record's URL, when the card found it by its externalId under another
   * one: the shop moved the listing, and the record follows it.
   */
  movedFrom?: string;
  /** Fields the minimum set asks for that the card lacks. */
  missingFields: string[];
  /** When the listing's detail page falls due again, once that was asked. */
  detailDueAt?: Date;
  /** The offer the card refreshes, on `refresh`. */
  externalId?: string;
}

/**
 * Decides, per list card, whether an already-known listing can be refreshed
 * from the card alone — and does it when so.
 *
 * This is where the cost saving actually happens: every card that satisfies the
 * minimum set is a paid detail fetch not spent. Never touches specs, images or
 * product identity; those change rarely, prices change constantly.
 *
 * The card updates this source's own record — its values for the offer, and
 * that it still lists it — and the offer is then composed from all of the
 * seller's records, as an import does (OfferComposerService). Under the
 * product's lock, like every other product writer.
 *
 * Two things still send a known listing to its detail page: a card too thin
 * for the minimum set, and age. A listing whose last detail import is older
 * than the source's detailRefreshInterval (less a per-URL spread, see
 * detail-refresh-schedule) is `stale`, because a card never shows a new GTIN,
 * spec, description or store list.
 */
@Injectable()
export class ListProductRefreshService {
  private readonly logger = new CustomLogger(ListProductRefreshService.name);

  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly mergeService: ProductMergeService,
    private readonly offerComposer: OfferComposerService,
    private readonly locks: AdvisoryLockService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  get requiredFields(): string[] {
    return (
      this.dynamicConfig.import?.listRefreshRequiredFields ??
      DEFAULT_LIST_REFRESH_REQUIRED_FIELDS
    );
  }

  /** True when the card carries every field the minimum set asks for. */
  satisfiesMinimumSet(item: ScrapedListProduct): boolean {
    return this.missingFields(item).length === 0;
  }

  /** The fields the minimum set asks for that this card lacks. */
  missingFields(item: ScrapedListProduct): string[] {
    return this.requiredFields.filter((field) => {
      const value = (item as unknown as Record<string, unknown>)[field];
      return value === undefined || value === null || value === '';
    });
  }

  /**
   * What a run does with this card, without writing anything. The import
   * simulation reports it per card; tryRefresh acts on it.
   */
  async decide(
    source: ProductSource,
    item: ScrapedListProduct,
    now = new Date(),
  ): Promise<ListItemDecision> {
    const url = normalizeUrl(item.url);
    const missingFields = this.missingFields(item);
    const { record, movedFrom } = await this.findRecord(source.id, item, url);

    // Never seen by THIS source. Even if another source knows the URL, this
    // one still needs its own record, which only a detail scrape produces.
    if (!record) return { outcome: 'unknown', missingFields };

    const known = { record, movedFrom, missingFields };
    if (movedFrom && (await this.sourceRecordRepo.findBySourceAndUrl(source.id, url))) {
      return { ...known, outcome: 'moved' };
    }

    if (missingFields.length > 0) return { ...known, outcome: 'incomplete' };

    // Checked before the in-place refresh, which never writes lastUpdated:
    // only a detail import does, so it dates what the card cannot show.
    const detailDueAt = detailRefreshDueAt({
      url,
      lastUpdated: record.lastUpdated,
      intervalMs: detailRefreshIntervalMs(source),
    });
    if (now > detailDueAt) return { ...known, detailDueAt, outcome: 'stale' };

    const externalId = record.model ? this.pickExternalId(record, item) : undefined;
    if (!externalId) return { ...known, detailDueAt, outcome: 'no_offer' };

    return { ...known, detailDueAt, externalId, outcome: 'refresh' };
  }

  /**
   * Try to refresh this card's listing without a detail scrape.
   *
   * Returns what happened so the caller can decide whether to enqueue a detail
   * task and can report the split — which is the number that says whether the
   * saving is real for this shop.
   *
   * A listing the card found under another URL moves to the card's URL first,
   * whatever happens next, so the detail scrape a stale or thin card still
   * needs updates this record rather than writing a second one.
   */
  async tryRefresh(
    source: ProductSource,
    item: ScrapedListProduct,
  ): Promise<ListItemOutcome> {
    const { outcome, record, movedFrom, externalId } = await this.decide(source, item);
    const modelId = record?.model?.id;
    if (outcome === 'unknown' || outcome === 'moved' || !record || !modelId) {
      return outcome === 'refresh' ? 'no_offer' : outcome;
    }

    const move = movedFrom
      ? { recordId: record.id, from: movedFrom, to: normalizeUrl(item.url) }
      : undefined;

    if (outcome !== 'refresh' || !externalId) {
      if (move) {
        await this.locks.withLocks([productLock(modelId)], () => this.moveListing(move));
      }
      return outcome === 'refresh' ? 'no_offer' : outcome;
    }

    const refreshed = await this.locks.withLocks([productLock(modelId)], async () => {
      if (move) await this.moveListing(move);
      return this.refresh({ source, recordId: record.id, modelId, externalId, item });
    });
    return refreshed ? 'refreshed' : 'no_offer';
  }

  /**
   * This source's record of the card: by (source, externalId) first, then by
   * URL.
   *
   * The externalId is what a shop keeps when it renames a product and so its
   * slug. Found by it, the record is this listing even under another URL, and
   * `movedFrom` says so. Only an unambiguous match on a record that sits on a
   * product counts: an id several records share (a group-level one) names no
   * single listing, and an unattached record has no product lock to move it
   * under. Both fall back to the URL, as does a card without an externalId.
   */
  private async findRecord(
    sourceId: string,
    item: ScrapedListProduct,
    url: string,
  ): Promise<{ record?: ProductSourceRecord; movedFrom?: string }> {
    if (item.externalId) {
      const byExternalId = await this.sourceRecordRepo.findUniqueBySourceAndExternalId(
        sourceId,
        item.externalId,
      );
      if (byExternalId?.model) {
        const movedFrom =
          byExternalId.url && byExternalId.url !== url ? byExternalId.url : undefined;
        return { record: byExternalId, movedFrom };
      }
    }

    const byUrl = await this.sourceRecordRepo.findBySourceAndUrl(sourceId, url);
    return { record: byUrl ?? undefined };
  }

  /**
   * Moves a listing to the URL its card now shows: the record's own URL, and
   * that of its offer entries which pointed at the old page, so the offer
   * links to the live one. Under the caller's product lock, on the record as
   * it is now; nothing is written when it has moved meanwhile.
   */
  private async moveListing(move: { recordId: string; from: string; to: string }): Promise<void> {
    // Without relations: saved with its loaded offers, a stale list would
    // re-bind an offer another writer has pointed at another record since.
    const record = await this.sourceRecordRepo.findById(move.recordId);
    if (!record || record.url !== move.from) return;

    if (record.scrapedProduct) {
      const offers = (record.scrapedProduct.offers ?? []).map((entry) => {
        // An entry without a native id derives its id from the URL: pinned
        // first, so it stays the id its offer is stored under.
        const pinned: ScrapedOffer =
          entry.resolvedExternalId === undefined
            ? { ...entry, resolvedExternalId: storedOfferExternalId(record, entry) ?? null }
            : { ...entry };
        if (entry.url && normalizeUrl(entry.url) === move.from) pinned.url = move.to;
        return pinned;
      });
      record.scrapedProduct = { ...record.scrapedProduct, offers };
    }
    record.url = move.to;
    await this.sourceRecordRepo.save(record);

    this.logger.log('A listing moved to a new URL', {
      recordId: record.id,
      from: move.from,
      to: move.to,
    });
  }

  /**
   * Under the product's lock, on the product and record as they are now: the
   * card's values go into the record's entry for the offer, then the offer is
   * composed and the product's price recomputed.
   */
  private async refresh(params: {
    source: ProductSource;
    recordId: string;
    modelId: string;
    externalId: string;
    item: ScrapedListProduct;
  }): Promise<boolean> {
    const { source, recordId, modelId, externalId, item } = params;
    const model = await this.productRepo.findOne({
      where: { id: modelId },
      relations: OFFER_COMPOSER_MODEL_RELATIONS,
    });
    const record = model?.sources?.find((candidate) => candidate.id === recordId);
    if (!model || !record?.scrapedProduct) return false;

    let found = false;
    const offers = (record.scrapedProduct.offers ?? []).map((entry) => {
      if (storedOfferExternalId(record, entry) !== externalId) return entry;
      found = true;
      return this.withCard(entry, item);
    });
    if (!found) return false;

    record.scrapedProduct = { ...record.scrapedProduct, offers };
    record.lastSeenAt = new Date();
    await this.sourceRecordRepo.save(record);

    const composed = await this.offerComposer.compose({
      model,
      seller: source.seller,
      externalIds: [externalId],
      sighted: true,
      create: false,
    });
    if (isEmpty(composed.offers)) return false;

    await this.mergeService.recomputePrice(model);
    await this.productRepo.save(model);
    return true;
  }

  /**
   * The card's values over the record's entry. Only what the card shows: a
   * card without stock data leaves the stored availability as it is — a
   * refresh may not degrade data it cannot observe. A card with a price and no
   * old price says the offer is not discounted.
   */
  private withCard(entry: ScrapedOffer, item: ScrapedListProduct): ScrapedOffer {
    const updated: ScrapedOffer = { ...entry };
    if (item.price !== undefined) {
      updated.price = item.price;
      updated.priceWithoutDiscount = item.priceWithoutDiscount ?? null;
    }
    if (item.currency !== undefined) updated.currency = item.currency;
    if (item.availability !== undefined) updated.availability = item.availability;
    return updated;
  }

  /**
   * Which of the record's offers this card refers to.
   *
   * Prefers an externalId match; falls back to the sole offer when the record
   * has exactly one. A record with several offers and no externalId on the card
   * is ambiguous, and guessing would write one variant's price onto another —
   * so it yields nothing and the caller falls back to a detail scrape.
   */
  private pickExternalId(
    record: ProductSourceRecord,
    item: ScrapedListProduct,
  ): string | undefined {
    const entries = record.scrapedProduct?.offers ?? [];
    if (isEmpty(entries)) return undefined;

    if (item.externalId) {
      const byExternalId = entries.find(
        (entry) =>
          entry.externalId === item.externalId ||
          storedOfferExternalId(record, entry) === item.externalId,
      );
      if (byExternalId) return storedOfferExternalId(record, byExternalId);
    }

    if (entries.length === 1) return storedOfferExternalId(record, entries[0]);

    this.logger.debug(
      'List card matched a record with several offers and no usable externalId',
      { url: item.url, offers: entries.length },
    );
    return undefined;
  }
}
