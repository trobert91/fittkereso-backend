import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  ProductResolutionFlow,
  type ProductResolutionCandidateRecord,
} from '@fittkereso-backend/database';
import { sortBy } from 'lodash';

export interface FingerprintParams {
  flow: ProductResolutionFlow;
  anchorKey: string;
  candidates?: ProductResolutionCandidateRecord[];
  /** `decisionSnapshot.kind` — matcher_accept / llm_resolved / etc. */
  decisionKind?: string;
  resolvedProductId?: string;
}

/**
 * Computes the change-detector for a resolution decision: *has this situation's
 * content actually changed since we last asked?*
 *
 * Deliberately excludes scores. A re-scrape routinely nudges a similarity score
 * by a point without changing anything a reviewer would decide differently, and
 * treating that as new information would put a settled row back in the queue —
 * exactly the repetition this pipeline exists to remove. What does count as new
 * information: a different candidate set, a candidate passing or failing a
 * different gate, a different decision kind, or a different resolved product.
 *
 * Only ever compared against another row for the same `anchorKey`, so it is a
 * change detector rather than a global identity.
 */
@Injectable()
export class ProductResolutionFingerprintService {
  public compute(params: FingerprintParams): string {
    const candidates = sortBy(
      (params.candidates ?? []).map((candidate) => ({
        id: candidate.candidateId,
        passed: candidate.gates?.passed ?? false,
        failedGates: [...(candidate.gates?.failedGates ?? [])].sort(),
      })),
      'id',
    );

    const canonical = JSON.stringify({
      flow: params.flow,
      anchorKey: params.anchorKey,
      candidates,
      decisionKind: params.decisionKind ?? null,
      resolvedProductId: params.resolvedProductId ?? null,
    });

    return createHash('sha256').update(canonical).digest('hex');
  }

  /** The scraped listing a resolution decision was about. `externalId` is
   *  preferred over `url` because it survives URL changes. */
  public listingAnchor(params: {
    sourceId: string;
    externalId?: string;
    url?: string;
  }): string | undefined {
    const listing = params.externalId ?? params.url;
    return listing ? `${params.sourceId}:${listing}` : undefined;
  }

  /** The ordered product pair a duplicate-detection decision was about. */
  public pairAnchor(productAId: string, productBId: string): string {
    return productAId < productBId
      ? `${productAId}:${productBId}`
      : `${productBId}:${productAId}`;
  }
}
