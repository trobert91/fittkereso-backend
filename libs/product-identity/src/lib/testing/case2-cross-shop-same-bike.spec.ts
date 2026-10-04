import { ACCEPT_SCORE } from '../product-identity.constants';
import {
  EBIKESHOP,
  SPEEDBIKE,
  asProduct,
  crossShopPairs,
  gatesOf,
  listing,
  listingOfProduct,
  listingWithoutSpecs,
  outcomeOf,
  productOf,
  sameBikeAcrossShops,
  scoreOfPair,
  withSpecs,
} from './catalog';

/**
 * Case 2 — the same bike in both shops, named slightly differently, with the
 * specs they both publish agreeing. Named alike (an equal key), it has to
 * merge: a miss here puts the same bike in the catalog twice with its offers
 * split between the two rows. Named differently, only an equal key attaches,
 * so it has to reach review — the LLM, or a duplicate pair for a person.
 *
 * Where the catalog contains the case outright it is used as it stands. Where
 * it doesn't, the case is assembled from two real halves: one shop's real name
 * key, the other shop's real name key, and one real spec bag given to both —
 * because the bike is the same, so its specs are. Nothing is invented; the
 * arrangement is the only thing arranged.
 */
describe('case 2: the same bike in both shops, named differently', () => {
  describe('the bikes the two shops really do share', () => {
    it('finds all four, and names them', () => {
      const shared = sameBikeAcrossShops().map((pair) => pair.product.nameKey);

      expect(shared.sort()).toEqual([
        'chacana lfc macina',
        'elite kapoho macina',
        'elite macina scarp sx',
        'kapoho macina master',
      ]);
    });

    it('attaches every one of them, with no gate raised against it', () => {
      const shared = sameBikeAcrossShops();

      expect(shared).toHaveLength(4);
      for (const { product, speedbike, ebikeshop } of shared) {
        expect(gatesOf(speedbike, ebikeshop)).toEqual([]);
        expect(scoreOfPair(speedbike, asProduct(ebikeshop))).toBe(100);
        expect(outcomeOf(speedbike, asProduct(ebikeshop))).toBe('attach');
        expect(speedbike.productId).toBe(product.id);
      }
    });

    it.each([
      ['chacana lfc macina', 2023],
      ['elite macina scarp sx', 2026],
    ])('attaches the shared %s of %i at a perfect 100', (nameKey, modelYear) => {
      const product = productOf(nameKey, modelYear);
      const fromSpeedbike = listingOfProduct(SPEEDBIKE, product.id);
      const fromEbikeshop = listingOfProduct(EBIKESHOP, product.id);

      expect(fromSpeedbike.nameKey).toBe(fromEbikeshop.nameKey);
      expect(scoreOfPair(fromSpeedbike, asProduct(fromEbikeshop))).toBe(100);
      expect(outcomeOf(fromSpeedbike, asProduct(fromEbikeshop))).toBe('attach');
    });

    it('sends a listing with no specs to review, not attach, when the other states its year', () => {
      // speedbike lists the Kapoho Elite twice and fills the spec table in on
      // only one of them. Every mismatch gate skips the empty one, but it
      // states no model year against ebikeshop's 2023, and a name alone cannot
      // tell this year's bike from last year's (missingSpecPenalty). So the
      // identical name lands in review instead of attaching: the price of never
      // silently merging two years.
      const speclessSpeedbike = listingWithoutSpecs(SPEEDBIKE, 'elite kapoho macina');
      const fromEbikeshop = listing(EBIKESHOP, 'elite kapoho macina');

      expect(speclessSpeedbike.specs).toBeUndefined();
      expect(fromEbikeshop.specs).toBeDefined();
      expect(gatesOf(speclessSpeedbike, fromEbikeshop)).toEqual([
        {
          gate: 'specMissing',
          spec: 'modelYear',
          severity: 25,
          queryValue: null,
          candidateValue: 2023,
        },
      ]);
      expect(scoreOfPair(speclessSpeedbike, asProduct(fromEbikeshop))).toBe(75);
      expect(outcomeOf(speclessSpeedbike, asProduct(fromEbikeshop))).toBe('ask_llm');
    });
  });

  /**
   * Each shop's real rendering of one model line: speedbike's key on the left,
   * ebikeshop's on the right, both carrying speedbike's real spec bag. One
   * shop prints a feature or model-number token the other leaves off, so the
   * keys differ: only an equal key attaches, and these reach review instead —
   * the LLM when it is on, a duplicate pair for a person while it is off.
   */
  describe('one shop prints a token the other leaves off', () => {
    it.each([
      ['kapoho macina master', 'abs kapoho macina master', 86],
      ['872 chacana lfc macina', 'chacana lfc macina', 85],
      ['892 chacana lfc macina', 'chacana lfc macina', 85],
    ])('sends speedbike %s and ebikeshop %s to review at %i', (leftKey, rightKey, score) => {
      const left = listing(SPEEDBIKE, leftKey);
      const right = listing(EBIKESHOP, rightKey);
      const sameBike = withSpecs(right, left.specs);

      expect(left.nameKey).not.toBe(right.nameKey);
      expect(gatesOf(left, sameBike)).toEqual([]);
      expect(scoreOfPair(left, sameBike)).toBe(score);
      expect(scoreOfPair(left, sameBike)).toBeGreaterThanOrEqual(ACCEPT_SCORE);
      expect(outcomeOf(left, sameBike)).toBe('ask_llm');
    });

    // The key splits letters from digits, so "Di2" is two words, and leaving
    // it off costs two omissions: the pair falls below NEAR_MISS_SCORE, where
    // no duplicate pair is opened. Under the old name key it scored 89.
    it('drops a pair one shop wrote without "Di2" below review', () => {
      const left = listing(SPEEDBIKE, 'macina master scarp sx');
      const sameBike = withSpecs(listing(EBIKESHOP, 'di2 macina master scarp sx'), left.specs);

      expect(gatesOf(left, sameBike)).toEqual([]);
      expect(scoreOfPair(left, sameBike)).toBe(68);
      expect(outcomeOf(left, sameBike)).toBe('not_found');
    });
  });

  /** A shop's own two renderings of one bike, which really did merge. */
  describe('one shop’s two renderings of a single bike', () => {
    it.each([[SPEEDBIKE, '773 l lycan macina', '773 lycan macina', 85]])(
      'sends %s %s and %s to review at %i: a size letter one listing kept',
      (shop, leftKey, rightKey, score) => {
        const left = listing(shop, leftKey);
        const right = listing(shop, rightKey);

        expect(left.productId).toBe(right.productId);
        expect(gatesOf(left, right)).toEqual([]);
        expect(scoreOfPair(left, asProduct(right))).toBe(score);
        expect(outcomeOf(left, asProduct(right))).toBe('ask_llm');
      },
    );
    it('splits a pair the shop itself merged, because the frames differ', () => {
      // ebikeshop filed its Trapéz Prime0 onto the same product as the
      // Alacsony one. Once the frame shapes are extracted, matching no longer
      // agrees: a different frame is a different product, so the shop's own
      // merge is the thing that looks wrong.
      const trapez = listing(EBIKESHOP, 'macina prime0 sport sx t-type tr');
      const alacsony = listing(EBIKESHOP, 'macina prime0 sport sx t-type');

      expect(trapez.productId).toBe(alacsony.productId);
      expect(trapez.specs?.['frameType']).toBe('Trapéz');
      expect(alacsony.specs?.['frameType']).toBe('Alacsony');
      expect(gatesOf(trapez, alacsony)).toEqual([
        expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'frameType' }),
      ]);
      expect(outcomeOf(trapez, asProduct(alacsony))).not.toBe('attach');
    });
  });

  describe('what a shared bike costs when the shops describe it differently', () => {
    it('still attaches when only one shop published the weight', () => {
      // ebikeshop publishes no weight on any listing; a spec only one side has
      // skips its gate, so the difference in coverage costs nothing.
      const product = productOf('elite macina scarp sx', 2026);
      const fromSpeedbike = listingOfProduct(SPEEDBIKE, product.id);
      const fromEbikeshop = listingOfProduct(EBIKESHOP, product.id);

      expect(fromSpeedbike.specs?.['weight']).toBeDefined();
      expect(fromEbikeshop.specs?.['weight']).toBeUndefined();
      expect(gatesOf(fromSpeedbike, fromEbikeshop)).toEqual([]);
      expect(outcomeOf(fromSpeedbike, asProduct(fromEbikeshop))).toBe('attach');
    });

    it('still attaches when only one shop published the torque', () => {
      // The other direction: ebikeshop gives this bike a torque figure and
      // speedbike gives none, which again costs nothing.
      const product = productOf('elite macina scarp sx', 2026);
      const fromSpeedbike = listingOfProduct(SPEEDBIKE, product.id);
      const fromEbikeshop = listingOfProduct(EBIKESHOP, product.id);

      expect(fromSpeedbike.specs?.['torque']).toBeUndefined();
      expect(fromEbikeshop.specs?.['torque']).toBeDefined();
      expect(outcomeOf(fromSpeedbike, asProduct(fromEbikeshop))).toBe('attach');
    });

    it('treats a more specific usage type as the same kind of bike', () => {
      // speedbike says "Összteleszkópos MTB" where ebikeshop says "MTB"; the
      // ebikes compatible values make the pair compatible rather than contradictory.
      const product = productOf('chacana lfc macina', 2023);
      const fromSpeedbike = listingOfProduct(SPEEDBIKE, product.id);
      const fromEbikeshop = listingOfProduct(EBIKESHOP, product.id);

      expect(fromSpeedbike.specs?.['usageType']).toBe('Összteleszkópos MTB');
      expect(fromEbikeshop.specs?.['usageType']).toBe('MTB');
      expect(gatesOf(fromSpeedbike, fromEbikeshop)).toEqual([]);
      expect(outcomeOf(fromSpeedbike, asProduct(fromEbikeshop))).toBe('attach');
    });
  });

  it('never attaches a cross-shop pair that is not the same bike', () => {
    const wrong = crossShopPairs().filter(
      (pair) => pair.score >= ACCEPT_SCORE && !pair.sameBike,
    );

    expect(wrong).toEqual([]);
  });
});
