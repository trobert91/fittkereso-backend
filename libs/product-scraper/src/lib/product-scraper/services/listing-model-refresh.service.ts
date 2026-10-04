import { Injectable } from '@nestjs/common';
import { chunk, last } from 'lodash';
import {
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';
import { CustomLogger } from '@fittkereso-backend/logger';
import { SpecPostProcessService } from './spec-post-process.service';

/** Listings read per database page. */
const PAGE_SIZE = 200;

export interface ListingModelRefreshParams {
  /** Count only: what would be asked, nothing called or written. */
  dryRun: boolean;
  sourceId?: string;
  categorySlug?: string;
  /** At most this many listings asked in one run. */
  limit: number;
  /** Extractions in flight at once. */
  concurrency: number;
}

export interface ListingModelRefreshSummary {
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
  /** Stopped at `limit` with listings left to ask. */
  more: boolean;
}

/**
 * Asks the model of every identifying listing already stored again under the
 * current rule (its contract: the category's left-out specs, examples and
 * the prompt's version), without re-importing it. Each listing is put through
 * the identity extraction as its own last import — its stored listing as both
 * the input and the record — so the reuse path asks for the model alone; and
 * only the model, its contract and its key are written back, its specs and
 * offers untouched.
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
  ) {}

  public async refresh(params: ListingModelRefreshParams): Promise<ListingModelRefreshSummary> {
    const summary: ListingModelRefreshSummary = {
      read: 0,
      current: 0,
      noTitle: 0,
      identityOff: 0,
      asked: 0,
      written: 0,
      failed: 0,
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
        afterId,
        limit: PAGE_SIZE,
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
          const results = await Promise.all(
            batch.map((record) => this.refreshOne(record, contractOf)),
          );
          summary.written += results.filter(Boolean).length;
          summary.failed += results.filter((written) => !written).length;
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

  /** Asks one listing's model and writes it alone. False when none came back. */
  private async refreshOne(
    record: ProductSourceRecord,
    contractOf: (slug: string) => string | undefined,
  ): Promise<boolean> {
    const stored = record.scrapedProduct as ScrapedProduct;
    if (!record.source) return false;
    try {
      const extracted = await this.specPostProcess.extractIdentity({
        context: { source: record.source, url: record.url ?? '' },
        scrapedProduct: stored,
        ownRecord: record,
      });
      const contract = contractOf(stored.category.slug);
      if (!extracted.model || !contract || extracted.modelContract !== contract) return false;

      await this.sourceRecordRepo.setModel(record.id, {
        model: extracted.model,
        displayName: `${extracted.brand} ${extracted.model}`,
        contract,
        key: this.matchQuery.normalizedModelOf(extracted) ?? null,
      });
      return true;
    } catch (error) {
      this.logger.warn('Listing model refresh failed for a listing', {
        recordId: record.id,
        error: (error as Error).message,
      });
      return false;
    }
  }
}
