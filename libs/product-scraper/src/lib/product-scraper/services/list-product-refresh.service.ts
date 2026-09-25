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
  /** Not seen before; only a detail page has its specs, brand and model. */
  | 'unknown'
  /** Known listing with no offer row to refresh yet. */
  | 'no_offer';

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
    return this.requiredFields.every((field) => {
      const value = (item as unknown as Record<string, unknown>)[field];
      return value !== undefined && value !== null && value !== '';
    });
  }

  /**
   * Try to refresh this card's listing without a detail scrape.
   *
   * Returns what happened so the caller can decide whether to enqueue a detail
   * task and can report the split — which is the number that says whether the
   * saving is real for this shop.
   */
  async tryRefresh(
    source: ProductSource,
    item: ScrapedListProduct,
  ): Promise<ListItemOutcome> {
    const record = await this.sourceRecordRepo.findBySourceAndUrl(
      source.id,
      normalizeUrl(item.url),
    );

    // Never seen by THIS source. Even if another source knows the URL, this
    // one still needs its own record, which only a detail scrape produces.
    if (!record) return 'unknown';

    if (!this.satisfiesMinimumSet(item)) return 'incomplete';

    const model = record.model;
    const externalId = this.pickExternalId(record, item);
    if (!model || !externalId) return 'no_offer';

    const refreshed = await this.locks.withLocks([productLock(model.id)], () =>
      this.refresh({ source, recordId: record.id, modelId: model.id, externalId, item }),
    );
    return refreshed ? 'refreshed' : 'no_offer';
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
