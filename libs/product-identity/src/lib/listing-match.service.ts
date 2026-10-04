import { Injectable } from '@nestjs/common';
import { take } from 'lodash';
import type {
  ListingMatchCandidate,
  ListingMatchDecision,
  ListingMatchLlmRecord,
  ListingMatchOutcome,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { listingNames } from '@fittkereso-backend/database';
import { BrandResolutionService } from '@fittkereso-backend/product';
import { decideListingMatch } from './listing-match-decision';
import { ListingMatchLlmService } from './listing-match-llm.service';
import {
  LISTING_DECISION_CANDIDATES,
  LLM_ENABLED,
} from './product-identity.constants';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductMatchQueryService } from './product-match-query.service';
import type { ProductCandidate, ProductMatchQuery } from './types';

export interface ListingMatchResult {
  /** The product to attach this listing to; absent means create one. */
  productId?: string;
  decision: ListingMatchDecision;
}

export interface ListingMatchOptions {
  /** False: never ask the LLM about near-misses; they become a new product. */
  llm?: boolean;
}

/**
 * Scrape-time listing matching: attach the listing to a stored product, ask the
 * LLM about the near-misses, or leave it to be created. Writes nothing — the
 * scraper persists, and stores the decision on its task.
 *
 * Only a product with the listing's normalizedModel can attach it, on its spec
 * gates (decideListingMatch). Those are exactly the candidates the exact-key
 * pass recalls, scored as the full search scores them, so when one attaches
 * the trigram search is skipped; otherwise it runs, for the near-misses the
 * LLM may be asked about. A listing without a model has no key: it is searched
 * by its title, and never attached by name.
 */
@Injectable()
export class ListingMatchService {
  constructor(
    private readonly brandResolution: BrandResolutionService,
    private readonly queryService: ProductMatchQueryService,
    private readonly finder: ProductCandidateFinderService,
    private readonly llmService: ListingMatchLlmService,
  ) {}

  /**
   * `options.llm: false` keeps the decision deterministic whatever
   * LLM_ENABLED says: the scraper's re-check under its brand lock must not
   * spend a call, or wait on one, while every other import of the brand waits
   * on it.
   */
  public async match(
    scrapedProduct: ScrapedProduct,
    logContext?: Record<string, string>,
    options: ListingMatchOptions = {},
  ): Promise<ListingMatchResult> {
    // A listing the extraction did not name goes by its title.
    const names = listingNames(scrapedProduct);
    const brand = await this.brandResolution.resolve(scrapedProduct.brand, names.displayName);
    // Recall is scoped by brand, so an unresolved one has nothing to search —
    // the same create path this listing has always taken.
    if (!brand?.entity) {
      return { decision: { outcome: 'created', candidates: [] } };
    }

    const query = this.queryService.ofListing(scrapedProduct, brand.entity);
    if (query.keyed) {
      const exact = await this.finder.findCandidates(query, { fuzzy: false });
      const choice = decideListingMatch(exact);
      if (choice.kind === 'attach') {
        return this.resultOf({
          outcome: 'identified',
          query,
          candidates: exact,
          productId: choice.candidate.productId,
          shortCircuit: true,
        });
      }
    }

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
    if (choice.kind === 'not_found' || !LLM_ENABLED || options.llm === false) {
      return this.resultOf({ outcome: 'created', query, candidates });
    }

    const llm = await this.llmService.pick(
      {
        brandName: query.brandName,
        model: scrapedProduct.model,
        title: scrapedProduct.originalName,
        normalizedModel: query.keyed ? query.keys?.[0] : undefined,
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
    query: ProductMatchQuery;
    candidates: ProductCandidate[];
    productId?: string;
    llm?: ListingMatchLlmRecord;
    shortCircuit?: boolean;
  }): ListingMatchResult {
    const { outcome, query, candidates, productId, llm, shortCircuit } = params;
    const [key] = query.keyed ? (query.keys ?? []) : [];
    // The chosen product first, then best first, as the finder ranked them.
    // Only the top few are worth storing on every import task.
    const chosen = candidates.find((candidate) => candidate.productId === productId);
    const ranked = chosen
      ? [chosen, ...candidates.filter((candidate) => candidate !== chosen)]
      : candidates;

    return {
      productId,
      decision: {
        outcome,
        candidates: take(ranked, LISTING_DECISION_CANDIDATES).map(snapshotOf),
        ...(key ? { normalizedModel: key } : {}),
        ...(shortCircuit ? { shortCircuit } : {}),
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
    ...(candidate.normalizedModelMatch !== undefined
      ? { normalizedModelMatch: candidate.normalizedModelMatch }
      : {}),
    keyScore: candidate.keyScore,
  };
}
