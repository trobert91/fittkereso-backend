import { Injectable } from '@nestjs/common';
import { chunk, compact, groupBy, isEmpty, isNil, last, pickBy } from 'lodash';
import {
  AdvisoryLockService,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSpecs,
  ScrapedProduct,
  productLock,
} from '@fittkereso-backend/database';
import { ProductMergeService } from '@fittkereso-backend/product';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { SpecPostProcessService } from './spec-post-process.service';
import { ListingColumnsFillSummary, ListingColumnsService } from './listing-columns.service';

/** Listings read per database page. */
const PAGE_SIZE = 200;

export interface ListingModelRefreshParams {
  /** Count only: what would be asked or written, nothing called or written. */
  dryRun: boolean;
  sourceId?: string;
  categorySlug?: string;
  /** Only these listings (ProductSourceRecord ids), for both passes. */
  recordIds?: string[];
  /** At most this many listings asked in one run. */
  limit: number;
  /** Extractions in flight at once. */
  concurrency: number;
}

export interface ListingModelRefreshSummary {
  /** The first pass: every listing's record columns filled from its stored listing. */
  columns: ListingColumnsFillSummary;
  /** Identifying sources' listings with a stored model, read. */
  read: number;
  /** Their model is already under the current contract: nothing to do. */
  current: number;
  /** Stored before the raw title was kept (no originalName): can't be asked. */
  noTitle: number;
  /** Whose source has the identity extraction off: never asked. */
  identityOff: number;
  /** Asked (or, in a dry run, would be). */
  asked: number;
  /** Asked, and renamed under the current contract. */
  written: number;
  /** Asked, and the call named nothing: the stored model stays, asked again next run or import. */
  failed: number;
  /** Products named again after a listing of theirs was renamed. */
  productsMerged: number;
  /** Stopped at `limit` with listings left to ask. */
  more: boolean;
}

/** One listing the call renamed. */
interface Renamed {
  record: ProductSourceRecord;
  model: string;
  contract: string;
  key: string | null;
  /** Spec values the call read that the stored listing lacked (see refreshModel). */
  specs?: ProductSpecs;
}

/**
 * Brings stored listings in line with the current model rule, without
 * re-importing them, in two passes:
 *
 * 1. Every listing's record columns — brand, model, title, normalizedModel —
 *    are filled from its stored listing (ListingColumnsService). No LLM.
 * 2. Every identifying listing whose model was asked under an older contract
 *    (other left-out specs, examples or prompt version) is asked again, as
 *    its own last import — its stored listing as both the input and the
 *    record — so the reuse path asks for the model alone. The model, its
 *    contract and its key are written back, plus any value of a spec the
 *    model leaves out that the stored listing lacked; its other specs and its
 *    offers stay untouched. Then its product is named and its specs merged
 *    again (ProductMergeService.mergeSources), under the product's lock.
 *
 * Feed runs skip unchanged rows, so without this a listing whose shop never
 * changes it would keep a model asked under an older rule.
 */
@Injectable()
export class ListingModelRefreshService {
  private readonly logger = new CustomLogger(ListingModelRefreshService.name);

  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly matchQuery: ProductMatchQueryService,
    private readonly listingColumns: ListingColumnsService,
    private readonly productRepo: ProductModelRepository,
    private readonly mergeService: ProductMergeService,
    private readonly locks: AdvisoryLockService,
  ) {}

  public async refresh(params: ListingModelRefreshParams): Promise<ListingModelRefreshSummary> {
    const summary: ListingModelRefreshSummary = {
      columns: await this.listingColumns.fill(params),
      read: 0,
      current: 0,
      noTitle: 0,
      identityOff: 0,
      asked: 0,
      written: 0,
      failed: 0,
      productsMerged: 0,
      more: false,
    };
    const contracts = new Map<string, string | undefined>();
    const contractOf = (slug: string) => {
      if (!contracts.has(slug)) contracts.set(slug, this.specPostProcess.modelContractOf(slug));
      return contracts.get(slug);
    };

    let afterId: string | undefined;
    for (;;) {
      const page = await this.sourceRecordRepo.findForModelRefresh({
        sourceId: params.sourceId,
        categorySlug: params.categorySlug,
        recordIds: params.recordIds,
        afterId,
        limit: PAGE_SIZE,
        named: true,
      });
      if (page.length === 0) break;
      afterId = last(page)?.id;
      summary.read += page.length;

      const due = page.filter((record) => this.isDue(record, contractOf, summary));
      const room = params.limit - summary.asked;
      if (due.length > room) summary.more = true;
      const toAsk = due.slice(0, Math.max(room, 0));
      summary.asked += toAsk.length;

      if (!params.dryRun) {
        for (const batch of chunk(toAsk, Math.max(params.concurrency, 1))) {
          const renamed = compact(
            await Promise.all(batch.map((record) => this.askOne(record, contractOf))),
          );
          summary.written += renamed.length;
          summary.failed += batch.length - renamed.length;
          summary.productsMerged += await this.write(renamed);
        }
      }
      if (summary.more || page.length < PAGE_SIZE) break;
    }

    this.logger.log('Listing model refresh finished', { ...params, ...summary });
    return summary;
  }

  /** Whether this listing needs asking, counting why not when it doesn't. */
  private isDue(
    record: ProductSourceRecord,
    contractOf: (slug: string) => string | undefined,
    summary: ListingModelRefreshSummary,
  ): boolean {
    const stored = record.scrapedProduct;
    const slug = stored?.category?.slug;
    if (!stored || !slug) return false;

    if (stored.modelContract === contractOf(slug)) {
      summary.current += 1;
      return false;
    }
    if (!stored.originalName) {
      summary.noTitle += 1;
      return false;
    }
    if (!record.source || !this.specPostProcess.identityEnabledFor(record.source)) {
      summary.identityOff += 1;
      return false;
    }
    return true;
  }

  /** Asks one listing's model, outside any lock. Undefined when none came back. */
  private async askOne(
    record: ProductSourceRecord,
    contractOf: (slug: string) => string | undefined,
  ): Promise<Renamed | undefined> {
    const stored = record.scrapedProduct as ScrapedProduct;
    if (!record.source) return undefined;
    try {
      const extracted = await this.specPostProcess.extractIdentity({
        context: { source: record.source, url: record.url ?? '' },
        scrapedProduct: stored,
        ownRecord: record,
      });
      const contract = contractOf(stored.category.slug);
      if (!extracted.model || !contract || extracted.modelContract !== contract) return undefined;

      const gained = pickBy(extracted.specs, (_value, key) => isNil(stored.specs?.[key]));
      return {
        record,
        model: extracted.model,
        contract,
        // As the column pass built it: with the record's resolved brand.
        key: this.matchQuery.normalizedModelOf(extracted, record.brand?.name) ?? null,
        ...(isEmpty(gained) ? {} : { specs: gained }),
      };
    } catch (error) {
      this.logger.warn('Listing model refresh failed for a listing', {
        recordId: record.id,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  /**
   * Writes the renamed listings and names each product they sit on again,
   * under that product's lock: an import holding the product with its records
   * loaded saves them back, so neither may write between the other's read and
   * save. How many products were named again.
   */
  private async write(renamed: Renamed[]): Promise<number> {
    const byProduct = groupBy(renamed, (each) => each.record.product?.id ?? '');
    let merged = 0;
    for (const [productId, listings] of Object.entries(byProduct)) {
      const writeAll = () =>
        Promise.all(
          listings.map(({ record, ...values }) => this.sourceRecordRepo.setModel(record.id, values)),
        );
      if (!productId) {
        await writeAll();
        continue;
      }
      await this.locks.withLocks([productLock(productId)], async () => {
        await writeAll();
        const product = await this.productRepo.findOne({
          where: { id: productId },
          relations: [
            nameOf<ProductModel>('brand'),
            nameOf<ProductModel>('productCategory'),
            nameOf<ProductModel>('aliases'),
            nameOf<ProductModel>('sources'),
            `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
          ],
        });
        if (!product) return;
        await this.mergeService.mergeSources(product);
        await this.productRepo.save(product);
        merged += 1;
      });
    }
    return merged;
  }
}
