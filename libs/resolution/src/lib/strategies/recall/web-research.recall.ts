import { Injectable } from '@nestjs/common';
import { ProductWebSearchService } from '@fittkereso-backend/product';
import { normalize } from '@fittkereso-backend/utils';
import { uniqBy } from 'lodash';
import type { RecallStrategy } from '../../models/strategy-types';
import type { ResolutionContext } from '../../models/resolution-context';
import type { SlimCandidate } from '../../models/slim-types';
import type {
  SearchEvidence,
  WebQueryIntent,
  WebQueryRecord,
} from '../../models/search-evidence';
import { WebSearchKeywordBuilder } from '../../web-search/web-search-keyword.builder';
import { SerpSkusExtractor } from '../../web-search/serp-skus.extractor';
import { CatalogResolver } from '../../web-search/catalog-resolver';

/**
 * Single web-research recall strategy. Replaces the three-way branch in the
 * legacy `WebResearchAgent` (anchored / enriched-unanchored / combined) with one
 * implementation that:
 *
 *  1. Picks `WebQueryIntent[]` based on the current context.
 *  2. Fires SERP queries in parallel via `ProductWebSearchService`.
 *  3. Builds a `SearchEvidence[]` union, each record tagged with its
 *     `queryIntent`. Dedupes by URL.
 *  4. Runs a **single** SKU-extraction LLM over the union.
 *  5. Catalog-resolves the extracted SKUs into `SlimCandidate[]`.
 *
 * Cross-market is just one of the intents — its evidence carries
 * `queryIntent: 'cross_market'`, which the decision LLM uses to reason about
 * regional renames at the end of the pipeline.
 *
 * Gating: runs only when `options.webSearchEnabled` is true AND fuzzy/embedding
 * recall yielded no qualifying pool (empty `ctx.candidates` after Stage 3) OR
 * the caller will run web research unconditionally for reference-product variant
 * search (set by Stage 6 via `webSearchEnabled`).
 */
@Injectable()
export class WebResearchRecallStrategy implements RecallStrategy {
  readonly name = 'web' as const;

  constructor(
    private readonly webSearch: ProductWebSearchService,
    private readonly keywordBuilder: WebSearchKeywordBuilder,
    private readonly serpExtractor: SerpSkusExtractor,
    private readonly catalogResolver: CatalogResolver,
  ) {}

  shouldRun(context: ResolutionContext): boolean {
    if (!context.options.webSearchEnabled) return false;
    // Single-shot — the orchestrator's fixed-point loop re-invokes recall after
    // filter+score; this guard stops web from re-firing on the rescue iteration.
    if (context.strategiesRun.includes('web')) return false;
    // Reference-product variant search always benefits from a SERP — the
    // reference is in the catalog already and we need sibling SKU evidence.
    if (context.referenceProduct) return true;
    // Otherwise web research is a fallback when fuzzy + embedding have produced
    // no pool to score.
    return context.candidates.length === 0;
  }

  async recall(context: ResolutionContext): Promise<SlimCandidate[]> {
    const intents = this.pickIntents(context);
    if (intents.length === 0) return [];

    // Build keyword for each intent, dedupe against ledger and against each
    // other (case-insensitive, normalized).
    type PreparedQuery = {
      intent: WebQueryIntent;
      keyword: string;
      normalized: string;
    };
    const prepared: PreparedQuery[] = [];
    const seenInRun = new Set<string>();
    for (const intent of intents) {
      const keyword = this.keywordBuilder.build(intent, context);
      if (!keyword) continue;
      const normalized = normalize(keyword);
      if (!normalized) continue;
      if (context.searchedKeywords.includes(normalized)) continue;
      if (seenInRun.has(normalized)) continue;
      seenInRun.add(normalized);
      prepared.push({ intent, keyword, normalized });
    }
    if (prepared.length === 0) return [];

    for (const { normalized } of prepared) {
      context.searchedKeywords.push(normalized);
    }

    // Fire SERP queries in parallel.
    const serpOutcomes = await Promise.allSettled(
      prepared.map((query) =>
        this.webSearch.search({
          keyword: query.keyword,
          searchDate: context.input.searchBefore,
        }),
      ),
    );

    const evidence: SearchEvidence[] = [];
    const queryRecords: WebQueryRecord[] = [];
    for (let index = 0; index < serpOutcomes.length; index++) {
      const outcome = serpOutcomes[index];
      const query = prepared[index];
      if (outcome.status === 'rejected') {
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        context.errors.push({
          phase: 'recall',
          message,
          detail: `web:${query.intent}`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      const response = outcome.value;
      const provider = (
        response.provider === 'exa' ? 'exa' : 'dataforseo'
      ) as SearchEvidence['provider'];
      queryRecords.push({
        intent: query.intent,
        keyword: query.keyword,
        provider,
        cacheHit: response.cacheHit ?? false,
        serpResultCount: response.results.length,
      });
      for (const result of response.results) {
        evidence.push({
          title: result.title,
          description: result.description ?? result.content ?? '',
          url: result.url,
          provider,
          queryIntent: query.intent,
          modelNumbers: [],
          resolvedProducts: [],
        });
      }
    }

    // Dedupe by URL across the union — same SERP record returned by both
    // queries collapses to one record carrying its first-seen queryIntent.
    const deduped = uniqBy(evidence, (record) => record.url);

    // Update the persisted webResearch block.
    context.webResearch = {
      queries: [...(context.webResearch?.queries ?? []), ...queryRecords],
      extractedModelNumbers: context.webResearch?.extractedModelNumbers ?? [],
      webOnlyModels: context.webResearch?.webOnlyModels ?? [],
    };

    if (deduped.length === 0) return [];

    // One SKU-extraction LLM call over the union.
    try {
      await this.serpExtractor.extract(context, deduped, undefined, {
        component: 'WebResearchRecallStrategy',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: 'recall',
        message,
        detail: 'web:serp_extraction',
        timestamp: new Date().toISOString(),
      });
      // Continue — records may still carry empty modelNumbers and catalog
      // resolver will simply produce no candidates.
    }

    // Catalog re-search.
    const { addedCandidates, webOnlyModels } =
      await this.catalogResolver.resolve(context, deduped);

    // Persist evidence + aggregated SKU lists for traces.
    context.searchEvidence.push(...deduped);
    const extractedSet = new Set(context.webResearch.extractedModelNumbers);
    for (const record of deduped) {
      for (const modelNumber of record.modelNumbers) {
        if (modelNumber.length > 0) extractedSet.add(modelNumber);
      }
    }
    const webOnlySet = new Set(context.webResearch.webOnlyModels);
    for (const sku of webOnlyModels) webOnlySet.add(sku);
    context.webResearch.extractedModelNumbers = Array.from(extractedSet);
    context.webResearch.webOnlyModels = Array.from(webOnlySet);

    return addedCandidates;
  }

  private pickIntents(context: ResolutionContext): WebQueryIntent[] {
    if (context.referenceProduct) {
      return ['reference_sibling_sku'];
    }
    const intents: WebQueryIntent[] = ['model_with_specs'];
    const hasBrand = (context.brand?.name ?? context.input.brand)?.trim();
    const hasModel = context.input.model?.trim();
    if (hasBrand && hasModel) {
      intents.push('cross_market');
    }
    return intents;
  }
}
