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

export interface MatcherModelBackfillParams {
  /** Count only: what would be asked, nothing called or written. */
  dryRun: boolean;
  sourceId?: string;
  categorySlug?: string;
  /** At most this many listings asked in one run. */
  limit: number;
  /** Extractions in flight at once. */
  concurrency: number;
}

export interface MatcherModelBackfillSummary {
  /** Identifying sources' listings with a stored extraction, read. */
  read: number;
  /** Already keyed under the current contract: nothing to do. */
  current: number;
  /** Stored before the raw title was kept (no originalName): can't be asked. */
  noTitle: number;
  /** Whose source has the identity extraction off: never asked. */
  identityOff: number;
  /** Asked (or, in a dry run, would be). */
  asked: number;
  /** Asked, and keyed. */
  written: number;
  /** Asked, and the call gave none: asked again on the next run or import. */
  failed: number;
  /** Stopped at `limit` with listings left to ask. */
  more: boolean;
}

/**
 * Gives every identifying listing already stored a matcherModel and its key,
 * without re-importing it. Each listing is put through the identity
 * extraction as its own last import — its stored listing as both the input
 * and the record — so the reuse path re-asks only the matcherModel; and only
 * the matcherModel, its contract and its key are written back, whatever the
 * call said about the name. Nothing is renamed.
 *
 * Feed runs skip unchanged rows, so without this a listing whose shop never
 * changes it would never get a key.
 */
@Injectable()
export class MatcherModelBackfillService {
  private readonly logger = new CustomLogger(MatcherModelBackfillService.name);

  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly specPostProcess: SpecPostProcessService,
    private readonly matchQuery: ProductMatchQueryService,
  ) {}

  public async backfill(params: MatcherModelBackfillParams): Promise<MatcherModelBackfillSummary> {
    const summary: MatcherModelBackfillSummary = {
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
      if (!contracts.has(slug)) contracts.set(slug, this.specPostProcess.matcherModelContractOf(slug));
      return contracts.get(slug);
    };

    let afterId: string | undefined;
    for (;;) {
      const page = await this.sourceRecordRepo.findForMatcherModelBackfill({
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
          const results = await Promise.all(batch.map((record) => this.keyOne(record)));
          summary.written += results.filter(Boolean).length;
          summary.failed += results.filter((written) => !written).length;
        }
      }
      if (summary.more || page.length < PAGE_SIZE) break;
    }

    this.logger.log('matcherModel backfill finished', { ...params, ...summary });
    return summary;
  }

  /** Whether this listing needs asking, counting why not when it doesn't. */
  private isDue(
    record: ProductSourceRecord,
    contractOf: (slug: string) => string | undefined,
    summary: MatcherModelBackfillSummary,
  ): boolean {
    const stored = record.scrapedProduct;
    const slug = stored?.category?.slug;
    if (!stored || !slug) return false;

    const contract = contractOf(slug);
    if (stored.matcherModel && stored.matcherModelContract === contract) {
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

  /** Asks one listing's matcherModel and writes it alone. False when none came back. */
  private async keyOne(record: ProductSourceRecord): Promise<boolean> {
    const stored = record.scrapedProduct as ScrapedProduct;
    if (!record.source) return false;
    try {
      const extracted = await this.specPostProcess.extractIdentity({
        context: { source: record.source, url: record.url ?? '' },
        scrapedProduct: stored,
        ownRecord: record,
      });
      if (!extracted.matcherModel || !extracted.matcherModelContract) return false;

      await this.sourceRecordRepo.setMatcherModel(record.id, {
        matcherModel: extracted.matcherModel,
        contract: extracted.matcherModelContract,
        key:
          this.matchQuery.matcherModelKeyOf(stored, extracted.matcherModel) ?? null,
      });
      return true;
    } catch (error) {
      this.logger.warn('matcherModel backfill failed for a listing', {
        recordId: record.id,
        error: (error as Error).message,
      });
      return false;
    }
  }
}
