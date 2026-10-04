import { Injectable } from '@nestjs/common';
import { take } from 'lodash';
import type {
  ListingMatchAlternative,
  ListingMatchCandidate,
  ListingMatchDecision,
  ListingMatchLlmRecord,
  ListingMatchMode,
  ListingMatchOutcome,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { listingNames } from '@fittkereso-backend/database';
import { BrandResolutionService } from '@fittkereso-backend/product';
import { ListingMatchChoice, decideListingMatch } from './listing-match-decision';
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
 * Two rules decide (decideListingMatch): the name score, and equal
 * matcherModel keys. The category's `matchingConfig.model.required`
 * picks the one that acts; the other runs in shadow and the decision records
 * what it would have done (`alternative`). A listing without a key always goes
 * by the score.
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
    const candidates = await this.finder.findCandidates(query);
    const [key] = query.matcherModelKeys ?? [];
    const required = this.queryService.requiresMatcherModel(query.categorySlug);
    const mode: ListingMatchMode = required && key ? 'key' : 'score';
    const decide = (rule: ListingMatchMode) =>
      decideListingMatch(candidates, { mode: rule, shortKey: wordsOf(key) < 2 });

    const choice = decide(mode);
    // Only a listing with a key has another rule to compare.
    const shadow = key ? decide(mode === 'key' ? 'score' : 'key') : undefined;
    const base = { query, candidates, mode, choice, shadow };

    if (choice.kind === 'attach') {
      return this.resultOf({
        ...base,
        outcome: 'identified',
        productId: choice.candidate.productId,
      });
    }

    // Nothing close enough to be worth a call, or the check is turned off: a
    // new product either way, which is what the LLM declining would give.
    if (choice.kind === 'not_found' || !LLM_ENABLED || options.llm === false) {
      return this.resultOf({ ...base, outcome: 'created' });
    }

    const llm = await this.llmService.pick(
      {
        brandName: query.brandName,
        model: scrapedProduct.model,
        displayName: names.displayName,
        nameKey: query.nameKey,
        specs: query.specs,
      },
      choice.candidates,
      logContext,
    );

    return this.resultOf({
      ...base,
      outcome: llm.productId ? 'llm_identified' : 'created',
      productId: llm.productId,
      llm,
    });
  }

  private resultOf(params: {
    outcome: ListingMatchOutcome;
    query: ProductMatchQuery;
    candidates: ProductCandidate[];
    mode: ListingMatchMode;
    choice: ListingMatchChoice<ProductCandidate>;
    shadow?: ListingMatchChoice<ProductCandidate>;
    productId?: string;
    llm?: ListingMatchLlmRecord;
  }): ListingMatchResult {
    const { outcome, query, candidates, mode, shadow, productId, llm } = params;
    const [key] = query.matcherModelKeys ?? [];
    // The chosen product first, whichever rule chose it; then best first, as
    // the finder ranked them. Only the top few are worth storing on every
    // import task.
    const chosen = candidates.find((candidate) => candidate.productId === productId);
    const ranked = chosen
      ? [chosen, ...candidates.filter((candidate) => candidate !== chosen)]
      : candidates;

    return {
      productId,
      decision: {
        outcome,
        nameKey: query.nameKey,
        candidates: take(ranked, LISTING_DECISION_CANDIDATES).map(snapshotOf),
        mode,
        ...(key ? { matcherModelKey: key } : {}),
        ...(shadow ? { alternative: alternativeOf(mode, shadow, productId) } : {}),
        ...(llm ? { llm } : {}),
      },
    };
  }
}

/** What the rule that didn't act would have done, against what was done. */
function alternativeOf(
  acting: ListingMatchMode,
  shadow: ListingMatchChoice<ProductCandidate>,
  productId: string | undefined,
): ListingMatchAlternative {
  const shadowProductId = shadow.kind === 'attach' ? shadow.candidate.productId : undefined;
  const comparison =
    shadowProductId === productId
      ? 'agree'
      : !shadowProductId
        ? 'split'
        : !productId
          ? 'join'
          : 'switch';

  return {
    mode: acting === 'key' ? 'score' : 'key',
    kind: shadow.kind,
    ...(shadowProductId ? { productId: shadowProductId } : {}),
    ...(shadow.kind === 'ask_llm' ? { llmCandidates: shadow.candidates.length } : {}),
    comparison,
  };
}

function wordsOf(key: string | undefined): number {
  return key ? key.split(' ').length : 0;
}

function snapshotOf(candidate: ProductCandidate): ListingMatchCandidate {
  return {
    productId: candidate.productId,
    displayName: candidate.displayName,
    score: candidate.score,
    matchedOn: candidate.matchedOn,
    failedGates: candidate.failedGates,
    ...(candidate.matcherModelMatch !== undefined
      ? { matcherModelMatch: candidate.matcherModelMatch }
      : {}),
    keyScore: candidate.keyScore,
  };
}
