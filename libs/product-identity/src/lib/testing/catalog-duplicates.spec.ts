import { pairRowOf } from '../duplicate-pairs';
import { NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  CatalogProduct,
  allScoredPairs,
  byKey,
  candidateOf,
  candidatesFor,
  pairByKey,
  scoreBetween,
  sharedKeyGroups,
} from './catalog';

/** What ProductDuplicateService.detect writes for one product. */
function detectPairsFor(product: CatalogProduct) {
  return candidatesFor(product)
    .filter((candidate) => candidate.score >= NEAR_MISS_SCORE)
    .map((candidate) => pairRowOf(product.id, candidate, 'scan'));
}

/** Every product caught up in a shared name key — enough to exercise detection. */
function productsSharingAKey(): CatalogProduct[] {
  return sharedKeyGroups().flat();
}

describe('duplicate detection on the real KTM catalog', () => {
  it('finds the duplicates the two shops actually left behind', () => {
    const groups = sharedKeyGroups();

    // Nine name keys are shared by more than one product, because the old
    // matcher never merged them — including one key held by three products.
    expect(groups).toHaveLength(9);
    expect(groups.reduce((n, group) => n + group.length, 0)).toBe(19);
    expect(groups.filter((group) => group.length === 3)).toHaveLength(1);
  });

  it('pairs a product with its identical twin', () => {
    const [a, b] = pairByKey('di2 macina master scarp sx');
    const pairs = detectPairsFor(a);

    expect(pairs).toContainEqual(
      expect.objectContaining({ similarityScore: 100, detectedBy: 'scan' }),
    );
    expect(
      pairs.map((pair) => [pair.productAId, pair.productBId].join()),
    ).toContain([a.id, b.id].sort().join());
  });

  it('pairs two frame shapes of one model so a person decides', () => {
    // Same name key, same year, same battery — one Trapéz frame, one Alacsony.
    // frameType became a primary spec on 2026-09-16, so this lands on the
    // near-miss line: written as a pair, never merged on its own.
    const [a, b] = pairByKey('macina prime0 sport sx t-type');

    expect(scoreBetween(a, b)).toBe(NEAR_MISS_SCORE);
    expect(detectPairsFor(a)).toContainEqual(
      expect.objectContaining({
        similarityScore: NEAR_MISS_SCORE,
        failedGates: [
          expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'frameType' }),
        ],
      }),
    );
  });

  it('writes a pair for all three products sharing one name key', () => {
    const trio = byKey('771 di2 glorious lycan macina');
    expect(trio).toHaveLength(3);

    // Each of the three sees the other two, so a scan settles on three pairs.
    const rows = trio.flatMap((product) => detectPairsFor(product));
    const distinct = new Set(rows.map((row) => `${row.productAId}|${row.productBId}`));

    expect(distinct.size).toBe(3);
    for (const row of rows) expect(row.similarityScore).toBe(100);
  });

  it('still pairs a model-year sibling, so a person gets to decide', () => {
    const [a, b] = pairByKey('chacana lfc macina');

    expect(scoreBetween(a, b)).toBe(NEAR_MISS_SCORE);
    expect(detectPairsFor(a)).toContainEqual(
      expect.objectContaining({
        similarityScore: NEAR_MISS_SCORE,
        failedGates: [
          expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'modelYear' }),
        ],
      }),
    );
  });

  it.each([
    ['810 belt city macina', 40],
    ['892 abs lfc macina team', 65],
  ])('writes nothing for %s, which the score rejects at %i', (nameKey, expected) => {
    const [a, b] = pairByKey(nameKey);

    expect(scoreBetween(a, b)).toBe(expected);
    const partners = detectPairsFor(a).flatMap((pair) => [
      pair.productAId,
      pair.productBId,
    ]);
    expect(partners).not.toContain(b.id);
  });

  it('never pairs anything below the near-miss bar', () => {
    for (const product of productsSharingAKey()) {
      for (const pair of detectPairsFor(product)) {
        expect(pair.similarityScore).toBeGreaterThanOrEqual(NEAR_MISS_SCORE);
      }
    }
  });

  describe('the stored row', () => {
    it('orders the two ids and moves each side onto A and B', () => {
      const [a, b] = pairByKey('chacana lfc macina');
      const row = pairRowOf(a.id, candidateOf(a, b), 'scrape');
      const queryIsA = a.id.toLowerCase() < b.id.toLowerCase();

      expect(row.productAId < row.productBId).toBe(true);
      expect([row.productAId, row.productBId].sort()).toEqual([a.id, b.id].sort());
      expect(row.detectedBy).toBe('scrape');
      expect(row.matchedOn).toBe('name');
      expect(row.matchedValue).toBe(b.nameKey);

      const [gate] = row.failedGates;
      expect(gate.productAValue).toBe(
        queryIsA ? a.specs?.['modelYear'] : b.specs?.['modelYear'],
      );
      expect(gate.productBValue).toBe(
        queryIsA ? b.specs?.['modelYear'] : a.specs?.['modelYear'],
      );
    });

    it('records the name similarity that produced the score', () => {
      const [a, b] = pairByKey('di2 macina master scarp sx');
      const row = pairRowOf(a.id, candidateOf(a, b), 'merge');

      expect(row.nameSimilarity).toEqual({ trigram: 1, levenshtein: 1 });
      expect(row.similarityScore).toBe(100);
    });

    it('produces the same row whichever product detection ran on', () => {
      const [a, b] = pairByKey('macina prime0 sport sx t-type');

      expect(pairRowOf(a.id, candidateOf(a, b), 'scan')).toEqual(
        pairRowOf(b.id, candidateOf(b, a), 'scan'),
      );
    });
  });

  it('keeps the pair count sane — detection is not a cross join', () => {
    const paired = allScoredPairs().filter((pair) => pair.score >= NEAR_MISS_SCORE);

    // 334 pairs are recalled; 15 are worth a person's attention. It was 19
    // until frameType became a primary spec and pushed four frame-shape pairs
    // below the bar.
    expect(paired).toHaveLength(15);
  });
});
