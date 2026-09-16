import {
  orderPairRows,
  ProductDuplicatePairRepository,
} from './product-duplicate-pair-repository';
import type { DuplicatePairRow } from '../types/product-duplicate-pair.types';

const ID_1 = '11111111-1111-1111-1111-111111111111';
const ID_2 = '22222222-2222-2222-2222-222222222222';
const ID_3 = '33333333-3333-3333-3333-333333333333';

function makeRow(overrides: Partial<DuplicatePairRow> = {}): DuplicatePairRow {
  return {
    productAId: ID_1,
    productBId: ID_2,
    similarityScore: 75,
    matchedOn: 'name',
    matchedValue: '140 hybrid stereo',
    failedGates: [],
    nameSimilarity: { trigram: 0.8, levenshtein: 0.75 },
    detectedBy: 'scan',
    ...overrides,
  };
}

describe('orderPairRows', () => {
  it('keeps the highest-scoring row per pair', () => {
    const rows = orderPairRows([
      makeRow({ similarityScore: 72, matchedValue: 'weaker' }),
      makeRow({ similarityScore: 88, matchedValue: 'stronger' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].matchedValue).toBe('stronger');
  });

  it('sorts rows by productAId, then productBId', () => {
    const rows = orderPairRows([
      makeRow({ productAId: ID_2, productBId: ID_3 }),
      makeRow({ productAId: ID_1, productBId: ID_3 }),
      makeRow({ productAId: ID_1, productBId: ID_2 }),
    ]);

    expect(rows.map((row) => [row.productAId, row.productBId])).toEqual([
      [ID_1, ID_2],
      [ID_1, ID_3],
      [ID_2, ID_3],
    ]);
  });

  // Mixed-case hex sorts differently in JS ('C' < 'b'); Postgres orders by value.
  it('compares and writes ids lowercased, the way Postgres orders uuids', () => {
    const [row] = orderPairRows([
      makeRow({
        productAId: 'b0000000-0000-0000-0000-000000000000',
        productBId: 'C0000000-0000-0000-0000-000000000000',
      }),
    ]);

    expect(row.productBId).toBe('c0000000-0000-0000-0000-000000000000');
  });

  it('throws on a row whose ids are not ordered A < B', () => {
    expect(() =>
      orderPairRows([makeRow({ productAId: ID_2, productBId: ID_1 })]),
    ).toThrow('must be ordered A < B');
    expect(() =>
      orderPairRows([makeRow({ productAId: ID_1, productBId: ID_1 })]),
    ).toThrow('must be ordered A < B');
  });
});

describe('ProductDuplicatePairRepository.upsertPairs', () => {
  let manager: { query: jest.Mock };
  let repository: ProductDuplicatePairRepository;

  beforeEach(() => {
    manager = { query: jest.fn().mockResolvedValue([{ id: 'pair-1' }]) };
    repository = Object.create(ProductDuplicatePairRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = {
      metadata: { tableName: 'product_duplicate_pair' },
      manager: { query: jest.fn() },
    };
  });

  it('writes nothing for no rows', async () => {
    await expect(repository.upsertPairs([], manager as never)).resolves.toBe(0);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('never reopens or refreshes a dismissed pair', async () => {
    await repository.upsertPairs([makeRow()], manager as never);

    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT ("productAId", "productBId") DO UPDATE SET');
    expect(sql).toContain('WHERE "product_duplicate_pair"."dismissedAt" IS NULL');
    expect(sql).not.toMatch(/"detectedBy" = EXCLUDED/);
  });

  it('sends one parameter set per pair, in (A, B) order, with gates as JSON', async () => {
    const gates = [
      {
        gate: 'primarySpecMismatch' as const,
        spec: 'modelYear',
        severity: 30,
        productAValue: 2023,
        productBValue: 2024,
      },
    ];

    await repository.upsertPairs(
      [
        makeRow({ productAId: ID_2, productBId: ID_3 }),
        makeRow({ productAId: ID_1, productBId: ID_2, failedGates: gates }),
      ],
      manager as never,
    );

    const [, params] = manager.query.mock.calls[0];
    expect(params).toHaveLength(16);
    expect(params.slice(0, 2)).toEqual([ID_1, ID_2]);
    expect(params[5]).toBe(JSON.stringify(gates));
    expect(params.slice(8, 10)).toEqual([ID_2, ID_3]);
  });
});
