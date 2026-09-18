import { decideListingMatch } from '../listing-match-decision';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  CATALOG,
  byKey,
  candidateOf,
  candidatesFor,
  gatesBetween,
  oneByKey,
  scoreBetween,
  trigramBetween,
} from './catalog';

/**
 * Pairs that look alike and are not the same bike. These are the cases scoring
 * has to get right — a false attach folds one product's offers into another,
 * which nobody notices until a price is wrong.
 */
describe('near misses the score correctly rejects', () => {
  it('separates the Lycan 771 from the Lycan 772', () => {
    const lycan771 = oneByKey('771 di2 glorious lycan macina');
    const lycan772 = oneByKey('772 di2 glorious lycan macina');

    // Trigram 0.875 and Levenshtein higher still — only the model-number gate
    // stands between these two, and it is the whole reason that gate exists.
    expect(trigramBetween(lycan771, lycan772)).toBeCloseTo(0.875, 3);
    expect(gatesBetween(lycan771, lycan772)).toEqual([
      expect.objectContaining({ gate: 'modelNumberMismatch', severity: 30 }),
    ]);
    expect(scoreBetween(lycan771, lycan772)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('separates a 2026 Di2 build from the 2022 bike it is named after', () => {
    const lycan771Di2 = oneByKey('771 di2 glorious lycan macina');
    const lycan771 = oneByKey('771 glorious lycan macina');

    expect(lycan771Di2.specs?.['modelYear']).not.toBe(lycan771.specs?.['modelYear']);
    expect(scoreBetween(lycan771Di2, lycan771)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('separates a Di2 build from the mechanical bike of the same name', () => {
    const di2 = oneByKey('di2 macina master scarp sx');
    const mechanical = oneByKey('macina master scarp sx');

    expect(trigramBetween(di2, mechanical)).toBeGreaterThan(0.8);
    expect(scoreBetween(di2, mechanical)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('keeps two trims of one model well below the bar on name alone', () => {
    // Master against Prestige: same year, same battery, no gate fires at all,
    // so the name carries the whole decision. The two names each hold a token
    // the other contradicts, which the blend reads as a substitution and
    // scores 68. It was 79 under max(trigram, Levenshtein) — one point from
    // auto-attaching, and the closest any wrong pair came.
    const master = oneByKey('di2 macina master scarp sx');
    const prestige = oneByKey('di2 macina prestige scarp sx');

    expect(gatesBetween(master, prestige)).toEqual([]);
    expect(scoreBetween(master, prestige)).toBe(68);
    expect(scoreBetween(master, prestige)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it.each([
    ['872 aera lfc macina', '872 abs aera lfc macina'],
    ['871 aera lfc macina', '871 aera di2 lfc macina'],
  ])('never auto-attaches %s to %s', (leftKey, rightKey) => {
    expect(scoreBetween(oneByKey(leftKey), oneByKey(rightKey))).toBeLessThan(
      ACCEPT_SCORE,
    );
  });
});

/**
 * Products whose names differ only by a frame token — "he", "tr", "l" — which
 * no configured spec distinguishes and which the model-number gate cannot
 * catch, because one number set contains the other.
 *
 * These were the calibration gap. Two things closed most of it on 2026-09-16:
 * extracting the frame shapes the shops publish and making frameType primary
 * separated the *shape* pairs outright, and the labelled set then showed the
 * one survivor is a frame *size* — a merge the reviewer confirmed is correct
 * (c005). Pinned all the same: nothing in the score tells a size token from a
 * shape token, so this list holding is luck, not design.
 */
describe('frame-token pairs that still attach', () => {
  /**
   * Picks one product precisely. Two of these name keys are held by more than
   * one product a model year apart, and only the same-year combination is the
   * dangerous one — the other is caught by the modelYear gate.
   */
  function productOf(nameKey: string, modelYear: number) {
    const found = byKey(nameKey).find(
      (product) => product.specs?.['modelYear'] === modelYear,
    );
    if (!found) throw new Error(`No "${nameKey}" from ${modelYear}`);
    return found;
  }

  it.each([['8973 kapoho l macina', '8973 kapoho macina', 2026, 84]])(
    'attaches %s to %s (%i) at %i with no gate to stop it',
    (leftKey, rightKey, modelYear, score) => {
      const left = productOf(leftKey, modelYear);
      const right = productOf(rightKey, modelYear);

      expect(gatesBetween(left, right)).toEqual([]);
      expect(scoreBetween(left, right)).toBe(score);
      expect(decideListingMatch([candidateOf(left, right)])).toEqual({
        kind: 'attach',
        candidate: expect.objectContaining({ productId: right.id }),
      });
    },
  );

  it('now separates the frame shapes it used to fold together', () => {
    // Until 2026-09-16 this pair scored 88 with no gate, because ebikeshop's
    // "Magas" never reached frameType. With the shape extracted and frameType
    // primary, the same pair is 30 points down and out of reach of an attach.
    const he2026 = productOf('810 belt city he macina', 2026);
    const city2026 = productOf('810 belt city macina', 2026);

    expect(he2026.specs?.['frameType']).toBe('Magas');
    expect(city2026.specs?.['frameType']).toBe('Alacsony');
    expect(gatesBetween(he2026, city2026)).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'frameType' }),
    ]);
    expect(scoreBetween(he2026, city2026)).toBe(55);
    expect(scoreBetween(he2026, city2026)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('stacks the frame shape on the model year and the usage type', () => {
    const he2026 = productOf('810 belt city he macina', 2026);
    const city2025 = productOf('810 belt city macina', 2025);

    expect(gatesBetween(he2026, city2025).map((gate) => gate.spec).sort()).toEqual([
      'frameType',
      'modelYear',
      'usageType',
    ]);
    expect(scoreBetween(he2026, city2025)).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('keeps the city bike and its trekking sibling below the bar', () => {
    // Two products share "810 belt city macina"; both are compared against the
    // "tr" variant. The best of those was 88 before the frame shapes were
    // extracted.
    const cityBikes = byKey('810 belt city macina');
    const trekking = byKey('810 belt city macina tr');
    const scores = cityBikes.flatMap((city) =>
      trekking.map((tr) => scoreBetween(city, tr)),
    );

    expect(Math.max(...scores)).toBe(56);
    expect(scores.some((score) => score >= ACCEPT_SCORE)).toBe(false);
  });
});

describe('what a scraped listing would do against this catalog', () => {
  it('attaches to the one product that matches it', () => {
    // Replay a stored product as if its listing were arriving now: its own row
    // is excluded, so this asks what the rest of the catalog offers.
    const product = oneByKey('di2 macina master scarp sx');
    const decision = decideListingMatch(candidatesFor(product));

    expect(decision.kind).toBe('attach');
    if (decision.kind === 'attach') {
      expect(decision.candidate.score).toBe(100);
      expect(decision.candidate.displayName).toContain('SCARP SX MASTER');
    }
  });

  it('sends a model-year sibling to the LLM instead of attaching it', () => {
    const product = oneByKey('chacana lfc macina');
    const decision = decideListingMatch(candidatesFor(product));

    expect(decision.kind).toBe('ask_llm');
    if (decision.kind === 'ask_llm') {
      expect(decision.candidates[0].score).toBe(NEAR_MISS_SCORE);
      expect(
        decision.candidates.every((candidate) => candidate.score >= NEAR_MISS_SCORE),
      ).toBe(true);
    }
  });

  it('asks the LLM rather than guessing when two products tie at the top', () => {
    const trio = byKey('771 di2 glorious lycan macina');
    const candidates = trio.slice(1).map((other) => candidateOf(trio[0], other));

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.score >= ACCEPT_SCORE)).toBe(true);
    expect(decideListingMatch(candidates).kind).toBe('ask_llm');
  });

  it('creates a new product for most of the catalog, which has no near neighbour', () => {
    const outcomes = CATALOG.map(
      (product) => decideListingMatch(candidatesFor(product)).kind,
    );
    const notFound = outcomes.filter((kind) => kind === 'not_found');

    // Recall is generous, so nearly every product sees neighbours — but the
    // score sends the clear majority straight to creation.
    expect(notFound.length).toBeGreaterThan(CATALOG.length / 2);
  });
});
