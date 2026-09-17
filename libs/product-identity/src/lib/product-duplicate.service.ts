import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isEmpty } from 'lodash';
import {
  DuplicateDetectedBy,
  ProductDuplicatePairRepository,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductMergeService } from '@fittkereso-backend/product';
import { nameOf } from '@fittkereso-backend/utils';
import { pairRowOf } from './duplicate-pairs';
import { NEAR_MISS_SCORE } from './product-identity.constants';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductMatchQueryService } from './product-match-query.service';

/**
 * Duplicate detection: which stored products look like the same product, and
 * what a person decided about them. Detection only ever writes pairs — two
 * products are merged when someone says so, never automatically.
 */
@Injectable()
export class ProductDuplicateService {
  private readonly logger = new CustomLogger(ProductDuplicateService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly pairRepo: ProductDuplicatePairRepository,
    private readonly queryService: ProductMatchQueryService,
    private readonly finder: ProductCandidateFinderService,
    private readonly mergeService: ProductMergeService,
  ) {}

  /**
   * Writes a pair for every candidate of this product scoring NEAR_MISS_SCORE
   * or above — the same bar a listing has to clear to reach the LLM, so a
   * near-miss the LLM declined still reaches a person. Returns the pairs
   * written; already-dismissed pairs aren't reopened and don't count.
   */
  public async detect(
    productId: string,
    detectedBy: DuplicateDetectedBy,
  ): Promise<number> {
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
      ],
    });
    if (!product) {
      this.logger.warn('Duplicate detection skipped: product not found', {
        productId,
      });
      return 0;
    }

    const candidates = await this.finder.findCandidates(
      this.queryService.ofProduct(product),
    );
    const rows = candidates
      .filter((candidate) => candidate.score >= NEAR_MISS_SCORE)
      .map((candidate) => pairRowOf(product.id, candidate, detectedBy));
    if (isEmpty(rows)) return 0;

    const written = await this.pairRepo.upsertPairs(rows);
    this.logger.log('Duplicate pairs detected', {
      productId,
      detectedBy,
      candidates: candidates.length,
      written,
    });
    return written;
  }

  /**
   * "Not duplicates": no later *detection* reopens the pair. Only a person
   * does, through `reopen` — which is the whole reason a dismissal is a
   * timestamp rather than a deletion.
   */
  public async dismiss(pairId: string): Promise<void> {
    const dismissed = await this.pairRepo.dismiss(pairId);
    if (!dismissed) {
      throw new NotFoundException(`Open duplicate pair ${pairId} not found`);
    }
  }

  /** Puts a dismissed pair back in the queue — someone changed their mind. */
  public async reopen(pairId: string): Promise<void> {
    const reopened = await this.pairRepo.reopen(pairId);
    if (!reopened) {
      throw new NotFoundException(`Dismissed duplicate pair ${pairId} not found`);
    }
  }

  /**
   * Merges one side of a pair into the other, which the caller picks.
   *
   * A dismissed pair merges too: "not duplicates" records what someone thought
   * at the time, and being wrong about it is exactly the case this has to
   * serve — otherwise the only route back is to dismiss, reopen, then merge.
   */
  public async mergePair(
    pairId: string,
    survivorProductId: string,
  ): Promise<ProductModel> {
    const pair = await this.pairRepo.findOne({ where: { id: pairId } });
    if (!pair) {
      throw new NotFoundException(`Duplicate pair ${pairId} not found`);
    }
    if (![pair.productAId, pair.productBId].includes(survivorProductId)) {
      throw new BadRequestException(
        `Product ${survivorProductId} is not part of duplicate pair ${pairId}`,
      );
    }

    const sourceId =
      pair.productAId === survivorProductId ? pair.productBId : pair.productAId;
    return this.mergeProducts(sourceId, survivorProductId, pairId);
  }

  /**
   * Folds the source product into the target and looks for the survivor's
   * duplicates again. The merge itself carries dismissals onto the survivor
   * and cascades the source's pairs away (ProductMergeService.mergeProducts),
   * so a failed re-detection costs nothing but a log line.
   */
  public async mergeProducts(
    sourceId: string,
    targetId: string,
    pairId?: string,
  ): Promise<ProductModel> {
    const { product, movedSourceRecordIds } =
      await this.mergeService.mergeProducts({ sourceId, targetId });
    this.logger.log('Products merged', {
      sourceId,
      targetId,
      pairId,
      movedSourceRecordIds,
    });

    try {
      await this.detect(targetId, 'merge');
    } catch (error: unknown) {
      this.logger.warn('Re-detection failed (the merge itself succeeded)', {
        targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return product;
  }
}
