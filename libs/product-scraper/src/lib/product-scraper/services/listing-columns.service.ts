import { Injectable } from '@nestjs/common';
import { last } from 'lodash';
import {
  Brand,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { BrandResolutionService } from '@fittkereso-backend/product';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';

/** Listings read per database page. */
const PAGE_SIZE = 200;

/** What a listing's record keeps beside its stored listing. */
export interface ListingColumns {
  brandId: string | null;
  model: string | null;
  originalTitle: string | null;
  normalizedModel: string | null;
}

export interface ListingColumnsFillSummary {
  /** Listings of a source read. */
  read: number;
  /** Their columns differed from their stored listing: written, or in a dry run would be. */
  changed: number;
}

/**
 * Fills the columns a listing's record keeps beside its stored listing — its
 * resolved brand, model, title and normalizedModel — from that listing, with
 * no LLM call. An import writes them for the listing it imports; this brings
 * every stored record in line, as after the columns are added or the key's
 * normalization changes.
 */
@Injectable()
export class ListingColumnsService {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly brandResolution: BrandResolutionService,
    private readonly matchQuery: ProductMatchQueryService,
  ) {}

  public async fill(params: {
    dryRun: boolean;
    sourceId?: string;
    categorySlug?: string;
  }): Promise<ListingColumnsFillSummary> {
    const summary: ListingColumnsFillSummary = { read: 0, changed: 0 };
    const brands = new Map<string, Promise<Brand | undefined>>();
    const brandOf = (listing: Partial<ScrapedProduct>) => {
      const key = `${listing.brand}\u0000${listing.originalName}`;
      const cached = brands.get(key);
      if (cached) return cached;
      const resolving = this.brandResolution
        .resolve(listing.brand, listing.originalName)
        .then((resolved) => resolved?.entity ?? undefined);
      brands.set(key, resolving);
      return resolving;
    };

    let afterId: string | undefined;
    for (;;) {
      const page = await this.sourceRecordRepo.findForModelRefresh({
        sourceId: params.sourceId,
        categorySlug: params.categorySlug,
        afterId,
        limit: PAGE_SIZE,
        named: false,
      });
      if (page.length === 0) break;
      afterId = last(page)?.id;
      summary.read += page.length;

      for (const record of page) {
        const listing = record.scrapedProduct;
        if (!listing) continue;
        const columns = this.columnsOf(record, await brandOf(listing));
        if (this.unchanged(record, columns)) continue;

        summary.changed += 1;
        if (!params.dryRun) await this.sourceRecordRepo.setListingColumns(record.id, columns);
      }
      if (page.length < PAGE_SIZE) break;
    }
    return summary;
  }

  /**
   * The columns, as an import writes them: a source that does not identify
   * products keeps no key, and nor does a listing without a model.
   */
  public columnsOf(record: ProductSourceRecord, brand: Brand | undefined): ListingColumns {
    const listing = record.scrapedProduct ?? {};
    const identifies = record.source?.identifiesProducts !== false;
    return {
      brandId: brand?.id ?? null,
      model: listing.model ?? null,
      originalTitle: listing.originalName ?? null,
      normalizedModel:
        identifies && listing.category
          ? (this.matchQuery.normalizedModelOf(listing as ScrapedProduct, brand?.name) ?? null)
          : null,
    };
  }

  private unchanged(record: ProductSourceRecord, columns: ListingColumns): boolean {
    return (
      (record.brand?.id ?? null) === columns.brandId &&
      (record.model ?? null) === columns.model &&
      (record.originalTitle ?? null) === columns.originalTitle &&
      (record.normalizedModel ?? null) === columns.normalizedModel
    );
  }
}
