import type { ProductCategoryConfig } from '@fittkereso-backend/database';
import { applyGates, keyScoreOf, scoreOf } from './gates';
import { decideListingMatch } from './listing-match-decision';

type Gate = 'primarySpecMismatch' | 'matcherSpecMismatch' | 'modelNumberMismatch' | 'specMissing';

/** A candidate with its name score, whether it has the listing's key, and its failed gates. */
const candidate = (
  productId: string,
  score: number,
  keyMatch: boolean | undefined,
  gates: Gate[] = [],
  createdAt = '2026-01-01',
) => ({
  productId,
  score,
  normalizedModelMatch: keyMatch,
  failedGates: gates.map((gate) => ({ gate })),
  keyScore: keyScoreOf(
    gates.map((gate) => ({
      gate,
      severity: gate === 'primarySpecMismatch' ? 30 : 10,
      queryValue: null,
      candidateValue: null,
    })),
  ),
  createdAt: new Date(createdAt),
});

describe('decideListingMatch', () => {
  it('attaches on an equal key and clean spec gates however low the name scores', () => {
    // A key built from the model, but the model-number check reads the names.
    const sameBike = candidate('same', 27, true, ['modelNumberMismatch']);

    expect(decideListingMatch([sameBike])).toEqual({ kind: 'attach', candidate: sameBike });
  });

  it('never attaches a perfect name with another key, and asks the LLM about it', () => {
    // "Style 810" against "Style 810 Di2".
    const variant = candidate('variant', 100, false);

    expect(decideListingMatch([variant])).toEqual({ kind: 'ask_llm', candidates: [variant] });
  });

  it('keeps an equal key the spec gates bring below 80 from attaching', () => {
    // Equal keys, a model year apart: another product.
    const lastYear = candidate('last-year', 100, true, ['primarySpecMismatch']);

    expect(decideListingMatch([lastYear])).toEqual({ kind: 'not_found' });
  });

  it("attaches a men's frame to the women's at 90: one matcher spec apart", () => {
    const otherFrame = candidate('other-frame', 90, true, ['matcherSpecMismatch']);

    expect(decideListingMatch([otherFrame])).toEqual({ kind: 'attach', candidate: otherFrame });
  });

  it('sends the LLM only names at 70 with no primary and at most one matcher contradiction', () => {
    const clean = candidate('clean', 100, false);
    const oneOff = candidate('one-off', 90, false, ['matcherSpecMismatch']);
    const twoOff = candidate('two-off', 80, false, ['matcherSpecMismatch', 'matcherSpecMismatch']);
    const primary = candidate('primary', 70, false, ['primarySpecMismatch']);
    const weakName = candidate('weak-name', 69, false);
    const missingSpec = candidate('missing', 75, false, ['specMissing']);

    expect(decideListingMatch([twoOff, weakName, primary, oneOff, missingSpec, clean])).toEqual({
      kind: 'ask_llm',
      candidates: [clean, oneOff, missingSpec],
    });
    expect(decideListingMatch([twoOff, primary, weakName])).toEqual({ kind: 'not_found' });
  });

  it('picks among products sharing the key by spec gates, then age — never a tie that blocks', () => {
    const older = candidate('older', 100, true, [], '2025-01-01');
    const newer = candidate('newer', 100, true, [], '2026-01-01');
    const offOne = candidate('off-one', 100, true, ['matcherSpecMismatch'], '2024-01-01');

    expect(decideListingMatch([newer, offOne, older])).toEqual({ kind: 'attach', candidate: older });
  });

  it('never attaches a candidate whose key is unknown', () => {
    const unkeyed = candidate('unkeyed', 100, undefined);

    expect(decideListingMatch([unkeyed])).toEqual({ kind: 'ask_llm', candidates: [unkeyed] });
  });

  it('creates without asking when nothing is close', () => {
    expect(decideListingMatch([candidate('far', 69, false)])).toEqual({ kind: 'not_found' });
    expect(decideListingMatch([])).toEqual({ kind: 'not_found' });
  });

  it('keeps identical names with one primary mismatch out of attach, and from the LLM', () => {
    const KEY = '140 hybrid stereo';
    const config: ProductCategoryConfig = {
      primarySpecs: ['modelYear', 'batteryCapacity'],
      matchingConfig: {
        specTolerances: { modelYear: { absolute: 0 }, batteryCapacity: { absolute: 0 } },
      },
    };
    const gates = applyGates({
      queryModel: KEY,
      candidateModel: KEY,
      querySpecs: { modelYear: 2024, batteryCapacity: 750 },
      candidateSpecs: { modelYear: 2023, batteryCapacity: 750 },
      categoryConfig: config,
    });
    const oneMismatch = {
      productId: 'year',
      score: scoreOf(100, gates),
      normalizedModelMatch: true,
      failedGates: gates,
      keyScore: keyScoreOf(gates),
    };

    expect(oneMismatch.keyScore).toBe(70);
    expect(decideListingMatch([oneMismatch])).toEqual({ kind: 'not_found' });
  });
});
