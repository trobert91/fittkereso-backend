import { Injectable } from '@nestjs/common';
import { compact, groupBy, isEmpty } from 'lodash';
import {
  AdvisoryLockService,
  OfferRepository,
  ProductModelRepository,
  ProductSource,
  ProductSourceRecordRepository,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  OFFER_COMPOSER_MODEL_RELATIONS,
  OfferComposerService,
  OfferFreshnessService,
  ProductMergeService,
} from '@fittkereso-backend/product';
import { UnchangedFeedRow } from './arukereso-feed-triage.service';

/**
 * An unchanged feed row's whole import: its offer and its listing are seen
 * again, with no task and no identity work.
 */
@Injectable()
export class ArukeresoFeedConfirmService {
  private readonly logger = new CustomLogger(ArukeresoFeedConfirmService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly mergeService: ProductMergeService,
    private readonly offerComposer: OfferComposerService,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly locks: AdvisoryLockService,
  ) {}

  /**
   * Stamps the rows' offers as synced and their listings as seen. A listing
   * that had stopped counting comes back: its offer had aged out of
   * visibility, or this source's record out of the window while another source
   * kept the offer alive. Its offer is composed again, so this source's values
   * count once more, and its product's price is recomputed.
   *
   * A contributing source's row that waits unattached has no offer: only its
   * listing is stamped. Returns how many offers were confirmed.
   */
  public async confirm(
    source: ProductSource,
    unchanged: UnchangedFeedRow[],
  ): Promise<number> {
    if (isEmpty(unchanged)) return 0;

    const cutoff = this.offerFreshness.visibleCutoff();
    const withOffer = unchanged.filter(
      (entry): entry is UnchangedFeedRow & { offerId: string; modelId: string } =>
        !!entry.offerId && !!entry.modelId,
    );
    await this.offerRepo.stampSynced(withOffer.map((entry) => entry.offerId));
    await this.sourceRecordRepo.stampSeen(
      source.id,
      unchanged.map((entry) => entry.row.url),
    );

    const revived = withOffer.filter(
      (entry) =>
        !entry.lastSynced || entry.lastSynced < cutoff || entry.recordSeenAt < cutoff,
    );
    for (const [modelId, entries] of Object.entries(
      groupBy(revived, (entry) => entry.modelId),
    )) {
      await this.locks.withLocks([productLock(modelId)], () =>
        this.recompose(source, modelId, entries),
      );
    }
    return withOffer.length;
  }

  private async recompose(
    source: ProductSource,
    modelId: string,
    entries: UnchangedFeedRow[],
  ): Promise<void> {
    const model = await this.productRepo.findOne({
      where: { id: modelId },
      relations: OFFER_COMPOSER_MODEL_RELATIONS,
    });
    if (!model) return;

    const { conflicts } = await this.offerComposer.compose({
      model,
      seller: source.seller,
      externalIds: compact(entries.map((entry) => entry.row.externalId)),
      sighted: true,
      create: false,
    });
    if (!isEmpty(conflicts)) {
      this.logger.warn('A revived feed row\'s offer sits on another product — left as it is', {
        source: source.name,
        productId: modelId,
        offerIds: conflicts.map((conflict) => conflict.details.offerId),
      });
    }
    await this.mergeService.recomputePrice(model);
    await this.productRepo.save(model);
  }
}
