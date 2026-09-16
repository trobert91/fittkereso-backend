import { pairRowOf } from './duplicate-pairs';
import type { ProductCandidate } from './types';

const SMALLER = '11111111-1111-1111-1111-111111111111';
const LARGER = '22222222-2222-2222-2222-222222222222';

function candidateOf(productId: string): ProductCandidate {
  return {
    productId,
    displayName: 'Cube Stereo Hybrid 140',
    score: 70,
    matchedOn: 'alias',
    matchedValue: 'Stereo Hybrid 140',
    nameSimilarity: { trigram: 0.9, levenshtein: 1 },
    failedGates: [
      {
        gate: 'primarySpecMismatch',
        spec: 'modelYear',
        severity: 30,
        queryValue: 2023,
        candidateValue: 2024,
      },
    ],
  };
}

describe('pairRowOf', () => {
  it('puts the query product on A when its id is smaller', () => {
    expect(pairRowOf(SMALLER, candidateOf(LARGER), 'scan')).toEqual({
      productAId: SMALLER,
      productBId: LARGER,
      similarityScore: 70,
      matchedOn: 'alias',
      matchedValue: 'Stereo Hybrid 140',
      failedGates: [
        {
          gate: 'primarySpecMismatch',
          spec: 'modelYear',
          severity: 30,
          productAValue: 2023,
          productBValue: 2024,
        },
      ],
      nameSimilarity: { trigram: 0.9, levenshtein: 1 },
      detectedBy: 'scan',
    });
  });

  it('swaps the gate values when the query product is B', () => {
    const row = pairRowOf(LARGER, candidateOf(SMALLER), 'scrape');

    expect([row.productAId, row.productBId]).toEqual([SMALLER, LARGER]);
    expect(row.failedGates[0]).toMatchObject({ productAValue: 2024, productBValue: 2023 });
  });

  // Mixed-case hex sorts differently in JS ('C' < 'b'); Postgres orders by value.
  it('orders and writes ids lowercased', () => {
    const row = pairRowOf(
      'C0000000-0000-0000-0000-000000000000',
      candidateOf('b0000000-0000-0000-0000-000000000000'),
      'merge',
    );

    expect(row.productAId).toBe('b0000000-0000-0000-0000-000000000000');
    expect(row.productBId).toBe('c0000000-0000-0000-0000-000000000000');
    expect(row.failedGates[0]).toMatchObject({ productAValue: 2024, productBValue: 2023 });
  });
});
