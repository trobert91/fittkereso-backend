import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  EBIKESHOP,
  LISTINGS,
  SPEEDBIKE,
  asProduct,
  crossShopPairs,
  decideAmong,
  distinctListings,
  gatesOf,
  listing,
  outcomeOf,
  scoreOfPair,
} from './catalog';

/**
 * Case 4 — two shops, two different bikes that look alike. A false attach here
 * is the worst outcome matching has: one shop's offers are folded onto another
 * shop's product, and the catalog shows a price for a bike nobody sells.
 *
 * These are harder than the same-shop siblings of case 1, because the shops
 * publish different spec sets: ebikeshop never publishes motorPower, weight or
 * frameMaterial, and speedbike publishes torque and topSpeed on a minority of
 * its listings. A gate whose spec is missing on either side skips, so
 * cross-shop pairs are judged on fewer gates than same-shop pairs are.
 */
describe('case 4: different bikes from different shops stay different products', () => {
  describe('a trim or model number apart, across the two shops', () => {
    it.each([
      ['6971 kapoho macina', 'kapoho macina master'],
      ['7973 kapoho macina', 'kapoho macina master'],
      ['8973 kapoho macina', 'kapoho macina master'],
      ['8973 kapoho l macina', 'kapoho macina master'],
      ['7972 kapoho macina ultimate', 'kapoho macina master'],
      ['comp kapoho ltd macina', 'kapoho macina master'],
      ['elite kapoho macina', 'abs kapoho macina master'],
      ['elite kapoho macina', 'kapoho macina prestige'],
      ['elite macina prowler', 'macina prestige prowler'],
      ['elite macina scarp sx', 'exonicx macina scarp sx t-type'],
      ['elite macina scarp sx', 'di2 macina master scarp sx'],
      ['elite macina scarp sx', 'di2 macina prestige scarp sx'],
    ])(
      'never attaches speedbike %s to ebikeshop %s',
      (leftKey, rightKey) => {
        const left = listing(SPEEDBIKE, leftKey);
        const right = listing(EBIKESHOP, rightKey);

        expect(left.productId).not.toBe(right.productId);
        expect(scoreOfPair(left, asProduct(right))).toBeLessThan(ACCEPT_SCORE);
        expect(outcomeOf(left, asProduct(right))).not.toBe('attach');
      },
    );

    it.each([
      ['6971 kapoho macina', 'kapoho macina master'],
      ['elite macina prowler', 'macina prestige prowler'],
      ['elite kapoho macina', 'kapoho macina prestige'],
    ])(
      'keeps speedbike %s and ebikeshop %s out of review entirely',
      (leftKey, rightKey) => {
        const left = listing(SPEEDBIKE, leftKey);
        const right = listing(EBIKESHOP, rightKey);

        expect(scoreOfPair(left, asProduct(right))).toBeLessThan(NEAR_MISS_SCORE);
        expect(outcomeOf(left, asProduct(right))).toBe('not_found');
      },
    );
  });

  describe('the closest cross-shop call in the catalog', () => {
    it('sends Master against Prestige to the LLM instead of merging them', () => {
      // 73 on the name, and not one gate fires: the shops agree on every spec
      // they both publish. Only the name distance keeps these two apart, and
      // it is the nearest any two different bikes get across the two shops.
      const master = listing(SPEEDBIKE, 'kapoho macina master');
      const prestige = listing(EBIKESHOP, 'kapoho macina prestige');

      expect(master.productId).not.toBe(prestige.productId);
      expect(gatesOf(master, prestige)).toEqual([]);
      expect(scoreOfPair(master, asProduct(prestige))).toBe(73);
      expect(outcomeOf(master, asProduct(prestige))).toBe('ask_llm');
    });

    it('lists every cross-shop pair of different bikes that reaches review', () => {
      const reviewed = crossShopPairs()
        .filter((pair) => pair.score >= NEAR_MISS_SCORE && !pair.sameBike)
        .map((pair) => [pair.speedbike.nameKey, pair.ebikeshop.nameKey, pair.score]);

      // Two, and both are real questions rather than mistakes: a Master against
      // a Prestige, and speedbike's 2022 Chacana against ebikeshop's 2023.
      expect(reviewed).toEqual([
        ['kapoho macina master', 'kapoho macina prestige', 73],
        ['chacana lfc macina', 'chacana lfc macina', 70],
      ]);
    });
  });

  /**
   * The structural reason cross-shop matching is harder, stated as a test: the
   * two shops barely overlap on the matcher specs, so those gates almost never
   * get the chance to fire across shops. If a shop starts publishing one of
   * these, this test is the place that notices.
   */
  describe('the two shops publish different specs, so fewer gates can fire', () => {
    it.each([['motorPower'], ['weight'], ['frameMaterial']])(
      'ebikeshop publishes no %s at all',
      (spec) => {
        const published = LISTINGS.filter(
          (row) => row.shop === EBIKESHOP && row.specs?.[spec] != null,
        );

        expect(published).toEqual([]);
      },
    );

    it.each([['motorPower'], ['weight'], ['frameMaterial']])(
      'so no cross-shop pair ever fails a %s gate',
      (spec) => {
        const fired = crossShopPairs().filter((pair) =>
          gatesOf(pair.speedbike, pair.ebikeshop).some(
            (gate) => gate.spec === spec,
          ),
        );

        expect(fired).toEqual([]);
      },
    );

    it('leaves speedbike’s torque and top speed on a minority of its listings', () => {
      const speedbike = LISTINGS.filter((row) => row.shop === SPEEDBIKE);
      const withTorque = speedbike.filter((row) => row.specs?.['torque'] != null);
      const withTopSpeed = speedbike.filter((row) => row.specs?.['topSpeed'] != null);

      expect(withTorque.length).toBeLessThan(speedbike.length / 2);
      expect(withTopSpeed.length).toBeLessThan(speedbike.length / 2);
    });
  });

  it('sends the overwhelming majority of cross-shop pairs to creation', () => {
    const pairs = crossShopPairs().filter((pair) => !pair.sameBike);
    const created = pairs.filter((pair) => pair.score < NEAR_MISS_SCORE);

    expect(pairs.length).toBeGreaterThan(20);
    expect(pairs.length - created.length).toBe(2);
  });

  it('attaches nothing across the two shops but the four bikes they share', () => {
    // Every speedbike listing against ebikeshop's whole catalogue: the only
    // cross-shop merges are the bikes both shops genuinely sell.
    const attaching = crossShopPairs().filter(
      (pair) => pair.score >= ACCEPT_SCORE,
    );

    expect(attaching).toHaveLength(4);
    expect(attaching.every((pair) => pair.sameBike)).toBe(true);
  });

  it('scores a speedbike listing against ebikeshop’s catalogue as a whole', () => {
    // The real shape of a scrape: one listing, every stored product recall
    // reaches, one decision. A bike only ebikeshop sells must create.
    const ebikeshopCatalog = distinctListings(EBIKESHOP).map(asProduct);
    const onlyOnSpeedbike = listing(SPEEDBIKE, '791 chacana macina');

    expect(decideAmong(onlyOnSpeedbike, ebikeshopCatalog).kind).toBe('not_found');
  });
});
