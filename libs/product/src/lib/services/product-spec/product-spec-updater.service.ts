import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSourceRecordUpdaterService } from './product-source-record-updater.service';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * Manual-spec-override entry point (admin "update manual specs" endpoint):
 * upserts a source: null ProductSourceRecord carrying the given specs, then
 * runs the same idempotent ProductMergeService.mergeSources recompute every
 * other update path uses — a manual edit participates in the merge as a
 * real candidate (see ProductSpecMergeService's Tier 4 recency/priority
 * tiebreak) rather than bypassing it.
 */
@Injectable()
export class ProductSpecUpdaterService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordUpdater: ProductSourceRecordUpdaterService,
    private readonly mergeService: ProductMergeService,
  ) {}

  public async updateManualSpecs(
    id: string,
    specs: ProductSpecs,
  ): Promise<ProductModel> {
    const product = await this.productRepo.findOneOrFail({
      where: { id },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
        `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      ],
    });

    await this.sourceRecordUpdater.upsertSourceRecord({
      model: product,
      source: null,
      scrapedProduct: { specs },
    });

    await this.mergeService.mergeSources(product);
    await this.productRepo.save(product);

    return product;
  }
}
