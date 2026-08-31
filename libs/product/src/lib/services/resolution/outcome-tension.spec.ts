import {
  ProductResolutionFlow,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import { deriveSystemAssertion, outcomeTension } from './outcome-tension';

describe('deriveSystemAssertion', () => {
  it('reads the seed verdict, which is immutable and captured before the backfill', () => {
    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
        seedVerdict: ResolutionVerdict.matched_existing,
      }),
    ).toBe('same');

    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
        seedVerdict: ResolutionVerdict.created_new,
      }),
    ).toBe('different');
  });

  it('trusts the seed over resolvedProductId, because the backfill sets that either way', () => {
    // `linkResolutionToListing` writes `resolvedProduct` for a newly *created*
    // product too, so on a persisted row the link cannot tell match from create.
    // Reading it instead of the seed would silently flip this row to "same".
    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
        seedVerdict: ResolutionVerdict.created_new,
        resolvedProductId: 'product-created-for-this-listing',
      }),
    ).toBe('different');
  });

  it('falls back to the catalog link when there is no seed entry', () => {
    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
        resolvedProductId: 'product-1',
      }),
    ).toBe('same');

    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
      }),
    ).toBe('different');
  });

  it('ignores a human verdict that somehow sits at index 0', () => {
    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.product_resolution,
        seedVerdict: ResolutionVerdict.decline,
        resolvedProductId: 'product-1',
      }),
    ).toBe('same');
  });

  it('always reports sameness for duplicate detection, whatever else it is given', () => {
    // Detection has no "these are different" outcome — every recorded pair is a
    // proposal that two products are one.
    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.duplicate_detection,
        seedVerdict: ResolutionVerdict.duplicate_proposed,
      }),
    ).toBe('same');

    expect(
      deriveSystemAssertion({
        flow: ProductResolutionFlow.duplicate_detection,
      }),
    ).toBe('same');
  });
});

describe('outcomeTension', () => {
  const resolution = (
    seedVerdict: ResolutionVerdict,
    similarityScore: number,
  ) =>
    outcomeTension({
      flow: ProductResolutionFlow.product_resolution,
      seedVerdict,
      similarityScore,
    });

  describe('the four cells', () => {
    it('is low when a match was made between things that look alike', () => {
      expect(resolution(ResolutionVerdict.matched_existing, 95)).toBeLessThan(
        0.1,
      );
    });

    it('is HIGH when a match was made between things that do not look alike', () => {
      // The case no existing signal catches: a confident-looking acceptance of
      // two products scoring 20 against each other.
      expect(
        resolution(ResolutionVerdict.matched_existing, 20),
      ).toBeGreaterThan(0.7);
    });

    it('is HIGH when things that look alike were declared different', () => {
      // A likely missed duplicate — the listing got its own product despite
      // scoring 95 against an existing one.
      expect(resolution(ResolutionVerdict.created_new, 95)).toBeGreaterThan(0.9);
    });

    it('is low when things that do not look alike were declared different', () => {
      expect(resolution(ResolutionVerdict.created_new, 20)).toBeLessThan(0.3);
    });
  });

  it('is symmetric — flipping the assertion mirrors the tension', () => {
    const same = resolution(ResolutionVerdict.matched_existing, 70);
    const different = resolution(ResolutionVerdict.created_new, 70);

    expect(same + different).toBeCloseTo(1);
  });

  describe('the recording floor', () => {
    it('stretches a truncated range so near-threshold rows stand out', () => {
      // Every recorded duplicate pair clears minScoreToRecord, so raw scores
      // bunch up at the top. Without rescaling a 62 and a 95 look similar; a 62
      // is in fact far more likely to be a false positive.
      const withoutFloor = outcomeTension({
        flow: ProductResolutionFlow.duplicate_detection,
        similarityScore: 62,
      });
      const withFloor = outcomeTension({
        flow: ProductResolutionFlow.duplicate_detection,
        similarityScore: 62,
        floor: 60,
      });

      expect(withoutFloor).toBeCloseTo(0.38);
      expect(withFloor).toBeGreaterThan(0.9);
    });

    it('still separates a near-threshold pair from a near-certain one', () => {
      const marginal = outcomeTension({
        flow: ProductResolutionFlow.duplicate_detection,
        similarityScore: 62,
        floor: 60,
      });
      const certain = outcomeTension({
        flow: ProductResolutionFlow.duplicate_detection,
        similarityScore: 95,
        floor: 60,
      });

      expect(marginal - certain).toBeGreaterThan(0.7);
    });
  });

  describe('bad input', () => {
    it('clamps scores outside 0–100', () => {
      expect(resolution(ResolutionVerdict.created_new, 140)).toBe(1);
      expect(resolution(ResolutionVerdict.created_new, -20)).toBe(0);
    });

    it('does not produce NaN for a missing or non-finite score', () => {
      const tension = resolution(
        ResolutionVerdict.created_new,
        undefined as unknown as number,
      );

      expect(Number.isFinite(tension)).toBe(true);
    });

    it('ignores a floor that would make the range collapse', () => {
      const tension = outcomeTension({
        flow: ProductResolutionFlow.duplicate_detection,
        similarityScore: 80,
        floor: 100,
      });

      expect(Number.isFinite(tension)).toBe(true);
    });
  });
});
