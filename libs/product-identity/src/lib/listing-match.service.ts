import { Injectable } from '@nestjs/common';
import { take } from 'lodash';
import type {
  ListingMatchCandidate,
  ListingMatchDecision,
  ListingMatchLlmRecord,
  ListingMatchOutcome,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { BrandResolutionService } from '@fittkereso-backend/product';
import { decideListingMatch } from './listing-match-decision';
import { ListingMatchLlmService } from './listing-match-llm.service';
import {
  LISTING_DECISION_CANDIDATES,
  LLM_ENABLED,
} from './product-identity.constants';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductMatchQueryService } from './product-match-query.service';
import type { ProductCandidate } from './types';

export interface ListingMatchResult {
  /** The product to attach this listing to; absent means create one. */
  productId?: string;
  decision: ListingMatchDecision;
}

/**
 * Scrape-time listing matching: attach the listing to a stored product, ask the
 * LLM about the near-misses, or leave it to be created. Writes nothing — the
 * scraper persists, and stores the decision on its task.
 */
@Injectable()
export class ListingMatchService {
  constructor(
    private readonly brandResolution: BrandResolutionService,
    private readonly queryService: ProductMatchQueryService,
    private readonly finder: ProductCandidateFinderService,
    private readonly llmService: ListingMatchLlmService,
  ) {}

  public async match(
    scrapedProduct: ScrapedProduct,
    logContext?: Record<string, string>,
  ): Promise<ListingMatchResult> {
    const brand = await this.brandResolution.resolve(
      scrapedProduct.brand,
      scrapedProduct.displayName,
    );
    // Recall is scoped by brand, so an unresolved one has nothing to search —
    // the same create path this listing has always taken.
    if (!brand?.entity) {
      return { decision: { outcome: 'created', candidates: [] } };
    }

    const query = this.queryService.ofListing(scrapedProduct, brand.entity);
    const candidates = await this.finder.findCandidates(query);
    const choice = decideListingMatch(candidates);

    if (choice.kind === 'attach') {
      return this.resultOf({
        outcome: 'identified',
        query,
        candidates,
        productId: choice.candidate.productId,
      });
    }

    // Nothing close enough to be worth a call, or the check is turned off: a
    // new product either way, which is what the LLM declining would give.
    if (choice.kind === 'not_found' || !LLM_ENABLED) {
      return this.resultOf({ outcome: 'created', query, candidates });
    }

    const llm = await this.llmService.pick(
      {
        brandName: query.brandName,
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
        nameKey: query.nameKey,
        specs: query.specs,
      },
      choice.candidates,
      logContext,
    );

    return this.resultOf({
      outcome: llm.productId ? 'llm_identified' : 'created',
      query,
      candidates,
      productId: llm.productId,
      llm,
    });
  }

  private resultOf(params: {
    outcome: ListingMatchOutcome;
    query: { nameKey: string };
    candidates: ProductCandidate[];
    productId?: string;
    llm?: ListingMatchLlmRecord;
  }): ListingMatchResult {
    const { outcome, query, candidates, productId, llm } = params;
    return {
      productId,
      decision: {
        outcome,
        nameKey: query.nameKey,
        // Already best first from the finder; only the top few are worth
        // storing on every scrape task.
        candidates: take(candidates, LISTING_DECISION_CANDIDATES).map(
          snapshotOf,
        ),
        ...(llm ? { llm } : {}),
      },
    };
  }
}

function snapshotOf(candidate: ProductCandidate): ListingMatchCandidate {
  return {
    productId: candidate.productId,
    displayName: candidate.displayName,
    score: candidate.score,
    matchedOn: candidate.matchedOn,
    failedGates: candidate.failedGates,
  };
}
