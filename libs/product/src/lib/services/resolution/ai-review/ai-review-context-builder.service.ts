import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductModel,
  ProductModelRepository,
  ProductResolution,
  ProductResolutionFlow,
  ResolutionReviewTrigger,
  type ProductResolutionCandidateRecord,
  type ProductResolutionState,
} from '@fittkereso-backend/database';
import { compact, isEmpty, uniq } from 'lodash';

/** How many same-brand products the `no_candidates_but_named` lookup may add. A
 *  reviewer needs the plausible neighbours, not the brand's whole catalogue. */
const MAX_BRAND_CATEGORY_LOOKUP = 25;

/** One candidate as the model sees it: the matcher's verdict beside the product
 *  as it exists right now. */
export interface AiReviewCandidate {
  /** `c1`, `c2`, … — never a real id. See `AiReviewContext.realIdByShortId`. */
  shortId: string;
  candidateId: string;
  /** True when this candidate came from the extra catalog lookup rather than
   *  from recall — it was never scored, and saying so stops the model reading a
   *  missing `matchScore` as a bad one. */
  fromCatalogLookup: boolean;
  /** What the matcher derived. Absent for a lookup candidate. */
  matchScore?: number;
  gates?: ProductResolutionCandidateRecord['gates'];
  filtered?: ProductResolutionCandidateRecord['filtered'];
  specMatchDetails?: ProductResolutionCandidateRecord['specMatchDetails'];
  /** The product as it is now. `undefined` means the product has since been
   *  deleted or merged away — which is itself decisive, and must not be silently
   *  rendered as a candidate that still exists. */
  live?: {
    displayName?: string;
    brand?: string;
    model?: string;
    category?: string;
    specs?: Record<string, unknown>;
    aliases: string[];
    price?: number | null;
    offerCount: number;
  };
}

export interface AiReviewContext {
  resolution: ProductResolution;
  candidates: AiReviewCandidate[];
  /** Reverse map for parsing the verdict. Local to one review — a short id never
   *  leaves this object. */
  realIdByShortId: Map<string, string>;
  /** Verified against live state, so a recommendation the model makes is one the
   *  action service will actually accept. */
  state: ProductResolutionState;
  triggers: ResolutionReviewTrigger[];
}

/**
 * Assembles everything a reviewer needs to judge one row.
 *
 * The division of labour is the design rule Phase 0 settled: **persist what
 * cannot be recomputed, load live what can.** The row carries the matcher's
 * verdicts — scores, component breakdowns, gate outcomes, spec comparisons —
 * because those depend on the config and code of the moment and are gone
 * otherwise. The products themselves are loaded fresh, because acting on this
 * row acts on them as they are now, and a stale copy would invite a decision on
 * grounds that no longer hold.
 *
 * That is also what lets the model do the judgement the matcher cannot: reading
 * live specs and aliases side by side, it can recognise "Bosch Performance Line
 * CX (Smart System)" and "Bosch PERFORMANCE CX Gen.4 SMART SYSTEM" as one motor,
 * which no string metric will.
 */
@Injectable()
export class AiReviewContextBuilderService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly offerRepo: OfferRepository,
  ) {}

  public async build(
    resolution: ProductResolution,
    state: ProductResolutionState,
  ): Promise<AiReviewContext> {
    const recorded = resolution.candidates ?? [];
    const lookedUp = await this.brandCategoryLookup(resolution, recorded);

    const ids = uniq([
      ...recorded.map((candidate) => candidate.candidateId),
      ...lookedUp.map((product) => product.id),
    ]);

    const [live, offerCounts] = await Promise.all([
      this.productRepo.findForReview(ids),
      this.offerRepo.countByModelIds(ids),
    ]);
    const liveById = new Map(live.map((product) => [product.id, product]));

    const candidates: AiReviewCandidate[] = [];
    const realIdByShortId = new Map<string, string>();

    const push = (
      candidateId: string,
      fromCatalogLookup: boolean,
      recordedEntry?: ProductResolutionCandidateRecord,
    ) => {
      const shortId = `c${candidates.length + 1}`;
      realIdByShortId.set(shortId, candidateId);
      candidates.push({
        shortId,
        candidateId,
        fromCatalogLookup,
        matchScore: recordedEntry?.matchScore,
        gates: recordedEntry?.gates,
        filtered: recordedEntry?.filtered,
        specMatchDetails: recordedEntry?.specMatchDetails,
        live: this.liveShape(liveById.get(candidateId), offerCounts),
      });
    };

    // Recall candidates keep their stored order, which the scoring stage left in
    // descending score — so `c1` is the matcher's own pick.
    for (const candidate of recorded) {
      push(candidate.candidateId, false, candidate);
    }
    for (const product of lookedUp) {
      if (liveById.has(product.id) && !recorded.some((c) => c.candidateId === product.id)) {
        push(product.id, true);
      }
    }

    return {
      resolution,
      candidates,
      realIdByShortId,
      state,
      triggers: resolution.reviewTriggers ?? [],
    };
  }

  /**
   * The one extra query a `no_candidates_but_named` row earns.
   *
   * Deliberately narrow: only that trigger, only when both ids resolved, and
   * capped. The trigger already established that this corner of the catalog is
   * populated, so this is fetching a known-non-empty set rather than guessing —
   * and without it the model would be handed a row with nothing to compare and
   * could only abstain.
   */
  private async brandCategoryLookup(
    resolution: ProductResolution,
    recorded: ProductResolutionCandidateRecord[],
  ): Promise<ProductModel[]> {
    if (
      resolution.flow !== ProductResolutionFlow.product_resolution ||
      !isEmpty(recorded) ||
      !resolution.reviewTriggers?.includes(
        ResolutionReviewTrigger.no_candidates_but_named,
      )
    ) {
      return [];
    }

    const snapshot =
      resolution.inputSnapshot?.kind === 'product_resolution'
        ? resolution.inputSnapshot
        : undefined;
    const brandId = snapshot?.brand?.id;
    const categoryId = snapshot?.category?.id;
    if (!brandId || !categoryId) return [];

    return this.productRepo.findByBrandAndCategory(
      brandId,
      categoryId,
      MAX_BRAND_CATEGORY_LOOKUP,
    );
  }

  private liveShape(
    product: ProductModel | undefined,
    offerCounts: Map<string, number>,
  ): AiReviewCandidate['live'] {
    if (!product) return undefined;

    return {
      displayName: product.displayName,
      brand: product.brand?.name,
      model: product.model,
      category: product.productCategory?.name,
      specs: product.specs as Record<string, unknown> | undefined,
      aliases: compact((product.aliases ?? []).map((alias) => alias.alias)),
      price: product.price,
      offerCount: offerCounts.get(product.id) ?? 0,
    };
  }
}
