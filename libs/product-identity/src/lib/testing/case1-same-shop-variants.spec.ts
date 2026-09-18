import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  EBIKESHOP,
  SPEEDBIKE,
  asProduct,
  gatesOf,
  listing,
  listingWithoutSpecs,
  outcomeOf,
  sameShopPairs,
  scoreOfPair,
} from './catalog';

/**
 * Case 1 — two listings from ONE shop that are not the same bike.
 *
 * A shop lists its whole range, so its near-neighbours are its own siblings:
 * the same model line a number apart, a trim above, a frame shape. Nothing
 * here may be folded together, and within one shop the specs are written by
 * one post-processor, so when they disagree the disagreement is real.
 */
describe('case 1: different bikes from the same shop stay different products', () => {
  describe('the model number is what separates a sibling', () => {
    it.each([
      [SPEEDBIKE, '771 di2 glorious lycan macina', '772 di2 glorious lycan macina'],
      [SPEEDBIKE, '872 chacana lfc macina', '892 chacana lfc macina'],
      [SPEEDBIKE, '791 chacana macina', '792 chacana macina'],
    ])('%s keeps %s apart from %s', (shop, leftKey, rightKey) => {
      const left = listing(shop, leftKey);
      const right = listing(shop, rightKey);

      expect(gatesOf(left, right)).toEqual([
        expect.objectContaining({ gate: 'modelNumberMismatch', severity: 30 }),
      ]);
      expect(scoreOfPair(left, asProduct(right))).toBeLessThan(NEAR_MISS_SCORE);
      expect(outcomeOf(left, asProduct(right))).toBe('not_found');
    });

    it('fires the gate on names similar enough to attach without it', () => {
      // 771 against 772 is one character in twenty-nine. On the name alone
      // these would attach outright; only the model-number gate stops them.
      const left = listing(SPEEDBIKE, '771 di2 glorious lycan macina');
      const right = listing(SPEEDBIKE, '772 di2 glorious lycan macina');
      const nameOnly = { ...asProduct(right), specs: undefined };

      expect(gatesOf(left, { nameKey: right.nameKey })).toEqual([
        expect.objectContaining({ gate: 'modelNumberMismatch' }),
      ]);
      expect(scoreOfPair(left, nameOnly)).toBeLessThan(NEAR_MISS_SCORE);
    });
  });

  describe('a trim or a model line away', () => {
    it.each([
      [SPEEDBIKE, '8973 kapoho l macina', 'comp kapoho ltd macina'],
      [SPEEDBIKE, '892 chacana lfc macina', '892 lycan macina'],
      [SPEEDBIKE, '792 chacana macina', 'chacana lfc macina'],
      [SPEEDBIKE, 'comp kapoho ltd macina', 'elite kapoho macina'],
      [SPEEDBIKE, 'elite kapoho macina', 'kapoho macina master'],
      [EBIKESHOP, 'elite macina scarp sx', 'exonicx macina scarp sx t-type'],
      [EBIKESHOP, 'kapoho macina prestige', 'macina prestige prowler'],
    ])('%s never attaches %s to %s', (shop, leftKey, rightKey) => {
      const left = listing(shop, leftKey);
      const right = listing(shop, rightKey);

      expect(scoreOfPair(left, asProduct(right))).toBeLessThan(ACCEPT_SCORE);
      expect(outcomeOf(left, asProduct(right))).not.toBe('attach');
    });

    it('separates one shop’s two model years of the same trekking bike', () => {
      // Two gates now: a year apart, and a Magas frame against a Trapéz one.
      const left = listing(EBIKESHOP, '810 axs cx gx macina tour');
      const right = listing(EBIKESHOP, '810 axs cx gx macina tour tr');

      expect(gatesOf(left, right).map((gate) => gate.spec).sort()).toEqual([
        'frameType',
        'modelYear',
      ]);
      expect(outcomeOf(left, asProduct(right))).toBe('not_found');
    });

    it('separates the ABS Master from the plain Master on two primary specs', () => {
      // ebikeshop sells both: a 2025 ABS bike with an 800Wh battery and the
      // 2023 Master with 750Wh. The names are 83 apart, which alone would
      // attach them — two primary gates take it far below review.
      const abs = listing(EBIKESHOP, 'abs kapoho macina master');
      const master = listing(EBIKESHOP, 'kapoho macina master');

      expect(abs.productId).not.toBe(master.productId);
      expect(gatesOf(abs, master).map((gate) => gate.spec).sort()).toEqual([
        'batteryCapacity',
        'modelYear',
      ]);
      expect(scoreOfPair(abs, asProduct(master))).toBeLessThan(NEAR_MISS_SCORE);
      expect(outcomeOf(abs, asProduct(master))).toBe('not_found');
    });
  });

  describe('the near-miss band, where a person or the LLM decides', () => {
    it('holds Master and Prestige well clear of attaching', () => {
      // Same year, same battery, no gate fires: only the name is between them.
      // "master" against "prestige" is a substitution — each name says
      // something the other contradicts — and the blend scores that 68, twelve
      // points off the bar. max(trigram, Levenshtein) had it at 79, one point
      // from a silent merge, and it was the closest call in the whole set.
      const master = listing(EBIKESHOP, 'di2 macina master scarp sx');
      const prestige = listing(EBIKESHOP, 'di2 macina prestige scarp sx');

      expect(gatesOf(master, prestige)).toEqual([]);
      expect(scoreOfPair(master, asProduct(prestige))).toBe(68);
      expect(outcomeOf(master, asProduct(prestige))).toBe('not_found');
    });
  });

  /**
   * Specs are what separate a shop's own siblings, so a listing published
   * without them is the dangerous one: every gate skips and the name decides
   * alone. speedbike lists the Kapoho Elite twice and fills the spec table in
   * on only one of the two rows, which is what makes this measurable.
   */
  describe('a listing with no specs has only its name to go on', () => {
    it.each([['6971 kapoho macina'], ['7973 kapoho macina'], ['8973 kapoho macina']])(
      'separates %s from the Kapoho Elite outright when both publish specs',
      (leftKey) => {
        const left = listing(SPEEDBIKE, leftKey);
        const elite = listing(SPEEDBIKE, 'elite kapoho macina');

        expect(elite.specs).toBeDefined();
        expect(gatesOf(left, elite).length).toBeGreaterThan(0);
        expect(scoreOfPair(left, asProduct(elite))).toBeLessThan(NEAR_MISS_SCORE);
        expect(outcomeOf(left, asProduct(elite))).toBe('not_found');
      },
    );

    it.each([
      ['6971 kapoho macina', 59],
      ['7973 kapoho macina', 59],
      ['8973 kapoho macina', 64],
    ])(
      'still separates %s from the Elite row that has none, at %i',
      (leftKey, score) => {
        const left = listing(SPEEDBIKE, leftKey);
        const specless = listingWithoutSpecs(SPEEDBIKE, 'elite kapoho macina');

        // With every gate skipped these used to land at 74, inside the review
        // band, purely on character overlap with "elite kapoho macina". The
        // name score now reads the difference for what it is — a model number
        // against a trim word, two tokens neither side shares — so the
        // specless row no longer drags them anywhere.
        expect(gatesOf(left, specless)).toEqual([]);
        expect(scoreOfPair(left, asProduct(specless))).toBe(score);
        expect(outcomeOf(left, asProduct(specless))).toBe('not_found');
      },
    );
  });

  /**
   * The two pairs from one shop that attach outright on different name keys:
   * no gate, no LLM call, no duplicate pair, nobody asked.
   *
   * It was five until 2026-09-16, when extracting the frame shapes ebikeshop
   * publishes (Magas / Trapéz) and making frameType primary cleared three. The
   * two left over were pinned here as suspected false attaches — and the
   * labelled set then cleared them too: the reviewer called both **one bike in
   * two frame sizes** (c005 and c007 in `labelled-cases.json`, the second of
   * them two Trapéz frames at TR46cm and TR51cm). So the merge is right and the
   * catalog's two product rows are what is wrong.
   *
   * They stay pinned all the same, because nothing in the score distinguishes a
   * frame *size* token from a frame *shape* token — these two are correct by
   * luck of which token it is, and if the list changes it must change
   * deliberately.
   */
  describe('differently-named pairs that attach within one shop', () => {
    it.each([
      [SPEEDBIKE, '8973 kapoho l macina', '8973 kapoho macina', 84],
      [EBIKESHOP, '810 belt city macina', '810 belt city macina tr', 86],
    ])(
      '%s attaches %s to %s at %i, which the reviewer confirmed is one bike',
      (shop, leftKey, rightKey, score) => {
        const left = listing(shop, leftKey);
        const right = listing(shop, rightKey);

        expect(left.productId).not.toBe(right.productId);
        expect(gatesOf(left, right)).toEqual([]);
        expect(scoreOfPair(left, asProduct(right))).toBe(score);
        expect(outcomeOf(left, asProduct(right))).toBe('attach');
      },
    );

    it('is the complete list of differently-named pairs that would auto-attach', () => {
      const attaching = [SPEEDBIKE, EBIKESHOP].flatMap((shop) =>
        sameShopPairs(shop)
          .filter(
            (pair) =>
              pair.score >= ACCEPT_SCORE &&
              !pair.sameProduct &&
              pair.a.nameKey !== pair.b.nameKey,
          )
          .map((pair) => [shop, pair.a.nameKey, pair.b.nameKey, pair.score]),
      );

      // The three GLORIOUS rows are new, and they are the point of the blend:
      // speedbike extracted one title twice, keeping the colourway once and
      // stripping it once, so its own catalogue holds the same bike under two
      // products. The reviewer called all of them one bike (c014–c017). The
      // old scorer put them at 70 and spent an LLM call on each.
      expect(attaching).toEqual([
        [SPEEDBIKE, '8973 kapoho l macina', '8973 kapoho macina', 84],
        [SPEEDBIKE, '771 di2 glorious lycan macina', '771 di2 lycan macina', 81],
        [SPEEDBIKE, '771 di2 glorious lycan macina', '771 di2 lycan macina', 81],
        [SPEEDBIKE, '772 di2 glorious lycan macina', '772 di2 lycan macina', 81],
        [EBIKESHOP, '810 belt city macina', '810 belt city macina tr', 86],
      ]);
    });

    it('never auto-attaches on identical names without also sharing a product', () => {
      // The identical-key pairs that reach ACCEPT_SCORE are the duplicate
      // groups the old matcher left behind, not a naming problem — they are
      // covered by the duplicate specs.
      const identical = [SPEEDBIKE, EBIKESHOP].flatMap((shop) =>
        sameShopPairs(shop).filter(
          (pair) =>
            pair.score >= ACCEPT_SCORE &&
            !pair.sameProduct &&
            pair.a.nameKey === pair.b.nameKey,
        ),
      );

      expect(identical.length).toBeGreaterThan(0);
      for (const pair of identical) {
        expect(pair.score).toBe(100);
        expect(gatesOf(pair.a, pair.b)).toEqual([]);
      }
    });
  });

  it('leaves the clear majority of a shop’s own pairs well apart', () => {
    for (const shop of [SPEEDBIKE, EBIKESHOP]) {
      const pairs = sameShopPairs(shop).filter((pair) => !pair.sameProduct);
      const separated = pairs.filter((pair) => pair.score < NEAR_MISS_SCORE);

      expect(pairs.length).toBeGreaterThan(0);
      expect(separated.length).toBeGreaterThan(pairs.length / 2);
    }
  });
});
