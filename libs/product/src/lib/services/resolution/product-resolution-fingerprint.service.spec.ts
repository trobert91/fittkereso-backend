import { ProductResolutionFlow } from '@fittkereso-backend/database';
import type { ProductResolutionCandidateRecord } from '@fittkereso-backend/database';
import { ProductResolutionFingerprintService } from './product-resolution-fingerprint.service';

function makeCandidate(
  overrides: Partial<ProductResolutionCandidateRecord> = {},
): ProductResolutionCandidateRecord {
  return {
    candidateId: 'candidate-1',
    source: 'fuzzy',
    matchScore: 80,
    gates: { passed: true, failedGates: [] },
    ...overrides,
  } as ProductResolutionCandidateRecord;
}

describe('ProductResolutionFingerprintService', () => {
  let service: ProductResolutionFingerprintService;

  const base = {
    flow: ProductResolutionFlow.product_resolution,
    anchorKey: 'source-1:sku-9',
    candidates: [makeCandidate()],
    decisionKind: 'matcher_accept',
    resolvedProductId: 'product-1',
  };

  beforeEach(() => {
    service = new ProductResolutionFingerprintService();
  });

  it('is stable for identical input', () => {
    expect(service.compute(base)).toBe(service.compute(base));
  });

  it('ignores candidate ordering, since recall order is not a decision change', () => {
    const a = service.compute({
      ...base,
      candidates: [
        makeCandidate({ candidateId: 'a' }),
        makeCandidate({ candidateId: 'b' }),
      ],
    });
    const b = service.compute({
      ...base,
      candidates: [
        makeCandidate({ candidateId: 'b' }),
        makeCandidate({ candidateId: 'a' }),
      ],
    });

    expect(a).toBe(b);
  });

  // The whole point of excluding scores: a re-scrape that nudges a score must
  // not put an already-decided row back in the review queue.
  it('does NOT change when only the scores move', () => {
    const before = service.compute(base);
    const after = service.compute({
      ...base,
      candidates: [makeCandidate({ matchScore: 81 })],
    });

    expect(after).toBe(before);
  });

  it('changes when the candidate set changes', () => {
    const after = service.compute({
      ...base,
      candidates: [makeCandidate(), makeCandidate({ candidateId: 'candidate-2' })],
    });

    expect(after).not.toBe(service.compute(base));
  });

  it('changes when a candidate starts failing a gate', () => {
    const after = service.compute({
      ...base,
      candidates: [
        makeCandidate({
          gates: { passed: false, failedGates: ['primary_spec_mismatch'] },
        }),
      ],
    });

    expect(after).not.toBe(service.compute(base));
  });

  it('changes when the decision kind changes', () => {
    expect(
      service.compute({ ...base, decisionKind: 'llm_unresolved' }),
    ).not.toBe(service.compute(base));
  });

  it('changes when the resolved product changes', () => {
    expect(
      service.compute({ ...base, resolvedProductId: 'product-2' }),
    ).not.toBe(service.compute(base));
  });

  it('separates situations: the same decision on a different listing hashes differently', () => {
    expect(service.compute({ ...base, anchorKey: 'source-1:sku-10' })).not.toBe(
      service.compute(base),
    );
  });

  describe('listingAnchor', () => {
    it('prefers externalId, which survives URL changes', () => {
      expect(
        service.listingAnchor({
          sourceId: 'source-1',
          externalId: 'sku-9',
          url: 'https://shop.hu/p/9',
        }),
      ).toBe('source-1:sku-9');
    });

    it('falls back to the URL when the source has no stable listing id', () => {
      expect(
        service.listingAnchor({
          sourceId: 'source-1',
          url: 'https://shop.hu/p/9',
        }),
      ).toBe('source-1:https://shop.hu/p/9');
    });

    it('returns undefined when there is nothing stable to anchor on', () => {
      expect(service.listingAnchor({ sourceId: 'source-1' })).toBeUndefined();
    });
  });

  describe('pairAnchor', () => {
    it('orders the ids so either argument order yields one anchor', () => {
      expect(service.pairAnchor('b', 'a')).toBe(service.pairAnchor('a', 'b'));
    });
  });
});
