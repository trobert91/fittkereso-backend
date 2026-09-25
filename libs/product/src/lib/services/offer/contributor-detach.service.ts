import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductModel,
  ProductSourceRecord,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { storedOfferExternalId } from '@fittkereso-backend/utils';
import { compact, isEmpty, uniq } from 'lodash';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * Takes a seller's contributing records (from sources that do not identify
 * products) off a product once no offer they joined is left on it, so an
 * unattached record always means "this seller has no offer for it". The
 * records of identifying sources stay: they are the product's own listings.
 *
 * A detached record attaches again when an identifying listing writes one of
 * its offers (ProductScrapeUpdaterService), or when its own source imports it
 * and finds one.
 */
@Injectable()
export class ContributorDetachService {
  private readonly logger = new CustomLogger(ContributorDetachService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly mergeService: ProductMergeService,
  ) {}

  /**
   * After the seller's offers under `externalIds` left this product: detaches
   * its contributing records that carried one of them and carry no offer still
   * on the product, then merges the product again without them.
   *
   * Under the caller's product lock, with the product loaded with its
   * records, their sources and sellers (OFFER_COMPOSER_MODEL_RELATIONS) and
   * its category. The caller saves the product. Returns the records detached.
   */
  public async detach(params: {
    model: ProductModel;
    sellerId: string;
    externalIds: string[];
  }): Promise<ProductSourceRecord[]> {
    const { model, sellerId } = params;
    const removed = new Set(params.externalIds);
    const candidates = (model.sources ?? []).filter(
      (record) =>
        record.source?.identifiesProducts === false &&
        record.source.seller?.id === sellerId &&
        keysOf(record).some((key) => removed.has(key)),
    );
    if (isEmpty(candidates)) return [];

    const otherKeys = uniq(
      candidates.flatMap((record) => keysOf(record).filter((key) => !removed.has(key))),
    );
    const kept = new Set(
      (await this.offerRepo.findBySellerAndExternalIds(sellerId, otherKeys))
        .filter((offer) => offer.model?.id === model.id)
        .map((offer) => offer.externalId),
    );
    const detached = candidates.filter(
      (record) => !keysOf(record).some((key) => kept.has(key)),
    );
    await this.detachRecords(model, detached);
    return detached;
  }

  /**
   * Takes these records off the product and merges it again without them.
   * Under the caller's product lock; the caller saves the product.
   */
  public async detachRecords(
    model: ProductModel,
    records: ProductSourceRecord[],
  ): Promise<void> {
    if (isEmpty(records)) return;
    const ids = new Set(records.map((record) => record.id));
    await this.sourceRecordRepo.detach([...ids]);
    model.sources = (model.sources ?? []).filter((record) => !ids.has(record.id));
    for (const record of records) record.model = null;
    await this.mergeService.mergeSources(model);

    this.logger.log('Detached contributing listings from a product', {
      productId: model.id,
      recordIds: [...ids],
    });
  }
}

/** The externalIds a record's offers are stored under. */
function keysOf(record: ProductSourceRecord): string[] {
  return uniq(
    compact(
      (record.scrapedProduct?.offers ?? []).map((entry) =>
        storedOfferExternalId(record, entry),
      ),
    ),
  );
}
