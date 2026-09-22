import type { ProductSpecs } from '@fittkereso-backend/database';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  CatalogListing,
  EBIKESHOP,
  LISTINGS,
  SPEEDBIKE,
  asProduct,
  gatesOf,
  listing,
  listingOfProduct,
  outcomeOf,
  productOf,
  sameBikeAcrossShops,
  scoreOfPair,
  specsWith,
  withSpecs,
} from './catalog';

/**
 * Case 3 — the two shops describe what is plausibly the same bike under
 * different names AND disagree on a spec. This is the hard middle: the score
 * has to tell a disagreement that still means "same bike" (vocabulary drift, a
 * figure one shop rounds differently) from one that means "different bike" (a
 * model year, a battery, a wheel size).
 *
 * The rule under test is the severities: a matcher spec costs 5 and must not
 * break an otherwise certain match, while a primary spec costs 30 and must.
 *
 * The disagreeing value is never invented — it is lifted from another real
 * listing, so both sides of every gate are values a shop actually published.
 */

/** A value some other listing really published for this spec, different from `current`. */
function realDifferentValue(
  key: string,
  current: ProductSpecs[string],
): ProductSpecs[string] {
  const found = LISTINGS.map((row) => row.specs?.[key]).find(
    (value) => value != null && String(value) !== String(current),
  );
  if (found === undefined) {
    throw new Error(`No other real value for "${key}" in the catalog`);
  }
  return found;
}

/** The same bike under the other shop's name, disagreeing on one spec. */
function otherShopWith(
  right: CatalogListing,
  leftSpecs: ProductSpecs | undefined,
  key: string,
) {
  const current = leftSpecs?.[key];
  if (current == null) {
    throw new Error(`The left listing publishes no "${key}" to disagree about`);
  }
  return withSpecs(
    right,
    specsWith(leftSpecs, key, realDifferentValue(key, current)),
  );
}

describe('case 3: same bike, different names, specs that do not quite agree', () => {
  describe('a matcher spec disagreeing costs 10 and does not break the merge', () => {
    it.each([
      [SPEEDBIKE, 'macina master scarp sx', EBIKESHOP, 'di2 macina master scarp sx'],
      [SPEEDBIKE, '8973 kapoho macina', SPEEDBIKE, '8973 kapoho l macina'],
      [SPEEDBIKE, '773 lycan macina', SPEEDBIKE, '773 l lycan macina'],
      [
        EBIKESHOP,
        'macina prime0 sport sx t-type',
        EBIKESHOP,
        'macina prime0 sport sx t-type tr',
      ],
    ])(
      '%s %s still reaches %s %s when the gear count differs',
      (leftShop, leftKey, rightShop, rightKey) => {
        const left = listing(leftShop, leftKey);
        const right = otherShopWith(
          listing(rightShop, rightKey),
          left.specs,
          'gearCount',
        );

        expect(gatesOf(left, right)).toEqual([
          expect.objectContaining({
            gate: 'matcherSpecMismatch',
            spec: 'gearCount',
            severity: 10,
          }),
        ]);
        // Each of these is one shop printing a token the other omits, which
        // the name score now treats alike however long the rest of the name
        // is — so every one of them sits within a point or two of the bar, and
        // the matcher's 10 is what decides. The band is doing its job here
        // rather than the severity being wrong: see the block below.
        expect(scoreOfPair(left, right)).toBeGreaterThanOrEqual(NEAR_MISS_SCORE);
        expect(outcomeOf(left, right)).not.toBe('not_found');
      },
    );

    it('costs exactly ten points and nothing more', () => {
      const left = listing(SPEEDBIKE, '8973 kapoho macina');
      const right = listing(SPEEDBIKE, '8973 kapoho l macina');
      const agreeing = withSpecs(right, left.specs);
      const disagreeing = otherShopWith(right, left.specs, 'gearCount');

      expect(scoreOfPair(left, agreeing)).toBe(84);
      expect(scoreOfPair(left, disagreeing)).toBe(74);
    });
  });

  describe('what a matcher spec is and is not enough to decide', () => {
    /**
     * The severity has to be read against the name score's own spread, and the
     * blend changed that spread. Under max(trigram, Levenshtein) an omitted
     * token cost more the shorter the name was, so these pairs ran from 77 to
     * 90 and 5 points landed somewhere different on each. They now cluster at
     * 84–86, because one omitted token is one omitted token — so 5 points is
     * the difference between attaching and asking, and nothing more.
     *
     * That is deliberate but tight, and it is the one place the blend put a
     * decision on a knife edge. It is pinned here so a future change to
     * GATE_SEVERITY or the blend weights has to look at it.
     */
    it.each([
      [SPEEDBIKE, 'kapoho macina master', EBIKESHOP, 'abs kapoho macina master', 86],
      [SPEEDBIKE, '872 chacana lfc macina', EBIKESHOP, 'chacana lfc macina', 85],
      [SPEEDBIKE, '8973 kapoho macina', SPEEDBIKE, '8973 kapoho l macina', 84],
    ])(
      'puts %s %s against %s %s at %i on the name alone',
      (leftShop, leftKey, rightShop, rightKey, score) => {
        const left = listing(leftShop, leftKey);
        const right = withSpecs(listing(rightShop, rightKey), left.specs);

        expect(scoreOfPair(left, right)).toBe(score);
        expect(gatesOf(left, right)).toEqual([]);
      },
    );

    it('cannot rescue a pair whose names disagree rather than omit', () => {
      // "master" against "prestige" is a substitution, not an omission: 65 on
      // the name, and no arrangement of matcher specs brings that near the bar.
      const left = listing(SPEEDBIKE, 'kapoho macina master');
      const right = withSpecs(listing(EBIKESHOP, 'kapoho macina prestige'), left.specs);

      expect(scoreOfPair(left, right)).toBe(65);
      expect(outcomeOf(left, right)).toBe('not_found');
    });
  });

  describe('a primary spec disagreeing always stops the merge', () => {
    it.each([
      [SPEEDBIKE, 'kapoho macina master', EBIKESHOP, 'abs kapoho macina master'],
      [SPEEDBIKE, 'macina master scarp sx', EBIKESHOP, 'di2 macina master scarp sx'],
      [SPEEDBIKE, '872 chacana lfc macina', EBIKESHOP, 'chacana lfc macina'],
      [SPEEDBIKE, '8973 kapoho macina', SPEEDBIKE, '8973 kapoho l macina'],
      [SPEEDBIKE, '773 lycan macina', SPEEDBIKE, '773 l lycan macina'],
      [EBIKESHOP, '810 belt city macina', EBIKESHOP, '810 belt city he macina'],
    ])(
      '%s %s never attaches to %s %s a model year apart',
      (leftShop, leftKey, rightShop, rightKey) => {
        const left = listing(leftShop, leftKey);
        const right = otherShopWith(
          listing(rightShop, rightKey),
          left.specs,
          'modelYear',
        );

        expect(gatesOf(left, right)).toEqual([
          expect.objectContaining({
            gate: 'primarySpecMismatch',
            spec: 'modelYear',
            severity: 30,
          }),
        ]);
        expect(scoreOfPair(left, right)).toBeLessThan(ACCEPT_SCORE);
        expect(outcomeOf(left, right)).not.toBe('attach');
      },
    );

    it('reports both shops’ values on the gate it raises', () => {
      const left = listing(SPEEDBIKE, 'kapoho macina master');
      const right = otherShopWith(
        listing(EBIKESHOP, 'abs kapoho macina master'),
        left.specs,
        'modelYear',
      );
      const [gate] = gatesOf(left, right);

      expect(gate.queryValue).toBe(left.specs?.['modelYear']);
      expect(gate.candidateValue).toBeDefined();
      expect(gate.candidateValue).not.toBe(gate.queryValue);
    });
  });

  describe('the disagreement the catalog already contains', () => {
    it('holds the two model years of the Chacana at exactly the near-miss line', () => {
      // Both shops sell a "chacana lfc macina" and key it identically, but
      // speedbike also carries the 2022 bike while ebikeshop carries the 2023.
      // The one primary gate takes a perfect name match to 70: reachable by
      // the LLM and by a person, never attached on its own.
      const older = listingOfProduct(
        SPEEDBIKE,
        productOf('chacana lfc macina', 2022).id,
      );
      const newer = listingOfProduct(
        EBIKESHOP,
        productOf('chacana lfc macina', 2023).id,
      );

      expect(older.nameKey).toBe(newer.nameKey);
      expect(older.productId).not.toBe(newer.productId);
      expect(gatesOf(older, newer)).toEqual([
        expect.objectContaining({
          gate: 'primarySpecMismatch',
          spec: 'modelYear',
          queryValue: 2022,
          candidateValue: 2023,
        }),
      ]);
      expect(scoreOfPair(older, asProduct(newer))).toBe(NEAR_MISS_SCORE);
      expect(outcomeOf(older, asProduct(newer))).toBe('ask_llm');
    });

    it('agrees on every spec for the bikes the shops genuinely share', () => {
      // Once each shop's listing is paired with the right product rather than
      // the right name, there is no disagreement left among the shared four.
      for (const { speedbike, ebikeshop } of sameBikeAcrossShops()) {
        expect(gatesOf(speedbike, ebikeshop)).toEqual([]);
      }
    });
  });
});
