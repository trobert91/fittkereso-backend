import { Injectable } from '@nestjs/common';
import { ProductSourceRecordRepository } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductSourceRecordSearchParams } from '../models/product-source-record-search-params';
import { ProductSourceRecordSearchResult } from '../models/product-source-record-search-result';
import { summarizeOfferSpecs } from './listing-offer-specs';

const DEFAULT_PAGE_SIZE = 50;

/** Every source's listings, as pages. The query itself is the repository's searchRecords. */
@Injectable()
export class ProductSourceRecordSearchService {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async search(
    params: ProductSourceRecordSearchParams,
  ): Promise<ProductSourceRecordSearchResult> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const sort = params.sort ?? 'seenAt';
    const order = params.order ?? 'DESC';

    const { items, total } = await this.sourceRecordRepo.searchRecords({
      productSourceIds: params.sourceIds,
      attached: params.attached,
      valid: params.valid,
      search: params.search?.trim() || undefined,
      productName: params.productName?.trim() || undefined,
      brand: params.brand?.trim() || undefined,
      categoryIds: params.categoryIds,
      sort,
      order,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const result = new ProductSourceRecordSearchResult();
    result.page = page;
    result.pageSize = pageSize;
    result.totalItems = total;
    result.totalPages = Math.ceil(total / pageSize);
    // Labelled by the listing's own category: its specs were mapped against it.
    result.items = items.map(({ offerEntrySpecs, ...row }) => ({
      ...row,
      offerSpecs: summarizeOfferSpecs(
        offerEntrySpecs,
        this.categoryConfigService.getJsonSchema(row.categorySlug),
      ),
    }));
    result.sort = sort;
    result.order = order;
    return result;
  }
}
