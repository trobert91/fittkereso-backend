import { ProductSourceRecordRepository } from './product-source-record-repository';

/** A query builder that records its calls and answers with the given results. */
function makeQueryBuilder(results: { getMany?: unknown; getCount?: number; getRawMany?: unknown }) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'leftJoin',
    'innerJoin',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'offset',
    'limit',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder['getMany'] = jest.fn().mockResolvedValue(results.getMany ?? []);
  builder['getCount'] = jest.fn().mockResolvedValue(results.getCount ?? 0);
  builder['getRawMany'] = jest.fn().mockResolvedValue(results.getRawMany ?? []);
  return builder;
}

function repositoryWith(builder: Record<string, jest.Mock>) {
  const repository = Object.create(ProductSourceRecordRepository.prototype);
  (repository as unknown as { repo: unknown }).repo = {
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  };
  return repository as ProductSourceRecordRepository;
}

const clauses = (builder: Record<string, jest.Mock>) =>
  [...builder['where'].mock.calls, ...builder['andWhere'].mock.calls].map(([clause]) =>
    String(clause),
  );

describe('ProductSourceRecordRepository.findFeedRowStates', () => {
  it('answers each URL with its hash, last sighting and product, null while unattached', async () => {
    const seen = new Date('2026-09-20');
    const builder = makeQueryBuilder({
      getMany: [
        { url: 'https://shop/a', feedRowHash: 'h1', lastSeenAt: seen, model: { id: 'model-1' } },
        { url: 'https://shop/b', feedRowHash: 'h2', lastUpdated: seen, model: null },
      ],
    });

    const states = await repositoryWith(builder).findFeedRowStates('source-1', [
      'https://shop/a',
      'https://shop/b',
    ]);

    expect(builder['leftJoin']).toHaveBeenCalledWith('record.model', 'model');
    expect(states.get('https://shop/a')).toEqual({ feedRowHash: 'h1', seenAt: seen, modelId: 'model-1' });
    expect(states.get('https://shop/b')).toEqual({ feedRowHash: 'h2', seenAt: seen, modelId: null });
  });
});

describe('ProductSourceRecordRepository.findUnattachedBySellerAndExternalIds', () => {
  it('queries nothing without ids', async () => {
    const builder = makeQueryBuilder({});

    expect(await repositoryWith(builder).findUnattachedBySellerAndExternalIds('seller-1', [])).toEqual([]);
    expect(builder['getMany']).not.toHaveBeenCalled();
  });

  it("looks only at the seller's unattached records, by their offers' stored keys", async () => {
    const builder = makeQueryBuilder({ getMany: [{ id: 'record-google' }] });

    const found = await repositoryWith(builder).findUnattachedBySellerAndExternalIds('seller-1', [
      'HAIBIKE-1',
    ]);

    expect(found).toEqual([{ id: 'record-google' }]);
    // With the source and its seller, as a product's records are loaded.
    expect(builder['innerJoinAndSelect'].mock.calls).toEqual([
      ['record.source', 'source'],
      ['source.seller', 'seller'],
    ]);
    const where = clauses(builder);
    expect(where).toContain('record."modelId" IS NULL');
    expect(where).toContain('seller.id = :sellerId');
    expect(where.some((clause) => clause.includes("entry ->> 'resolvedExternalId' IN (:...externalIds)"))).toBe(true);
    expect(builder['andWhere']).toHaveBeenCalledWith(expect.any(String), { externalIds: ['HAIBIKE-1'] });
  });
});

describe('ProductSourceRecordRepository.countUnattached', () => {
  it("counts the source's records with no product", async () => {
    const builder = makeQueryBuilder({ getCount: 3 });

    expect(await repositoryWith(builder).countUnattached('source-1')).toBe(3);
    expect(clauses(builder)).toEqual(['record."sourceId" = :sourceId', 'record."modelId" IS NULL']);
  });
});

describe('ProductSourceRecordRepository.findUniqueBySourceAndExternalId', () => {
  function repositoryFinding(records: unknown[]) {
    const repository = Object.create(ProductSourceRecordRepository.prototype);
    const find = jest.fn().mockResolvedValue(records);
    (repository as unknown as { repo: unknown }).repo = { find };
    return { repository: repository as ProductSourceRecordRepository, find };
  }

  it("returns the source's one record with that externalId, with its product and offers", async () => {
    const record = { id: 'record-1' };
    const { repository, find } = repositoryFinding([record]);

    await expect(repository.findUniqueBySourceAndExternalId('source-1', 'SKU-1')).resolves.toBe(record);
    expect(find).toHaveBeenCalledWith({
      where: { source: { id: 'source-1' }, externalId: 'SKU-1' },
      relations: ['model', 'offers'],
      take: 2,
    });
  });

  // A group-level id shared by a product's sizes names no single listing.
  it('returns null when several records share the externalId', async () => {
    const { repository } = repositoryFinding([{ id: 'record-1' }, { id: 'record-2' }]);

    await expect(repository.findUniqueBySourceAndExternalId('source-1', 'GROUP-1')).resolves.toBeNull();
  });

  it('returns null when no record has it', async () => {
    const { repository } = repositoryFinding([]);

    await expect(repository.findUniqueBySourceAndExternalId('source-1', 'SKU-1')).resolves.toBeNull();
  });
});

describe('ProductSourceRecordRepository.searchRecords', () => {
  it('filters by source, attachment and text, and shapes each row', async () => {
    const seen = new Date('2026-09-20');
    const builder = makeQueryBuilder({
      getCount: 1,
      getRawMany: [
        {
          id: 'record-google',
          sourceId: 'source-1',
          sourceName: 'speedbike-googleshop',
          url: 'https://shop/a',
          externalId: 'HAIBIKE-1',
          offerExternalIds: ['HAIBIKE-1', null],
          title: 'HAIBIKE SDURO',
          price: '1499990',
          productId: null,
          productName: null,
          seenAt: seen,
        },
      ],
    });

    const result = await repositoryWith(builder).searchRecords({
      productSourceId: 'source-1',
      attached: false,
      search: 'haibike',
      skip: 50,
      take: 25,
    });

    expect(result).toEqual({
      total: 1,
      items: [
        expect.objectContaining({ offerExternalIds: ['HAIBIKE-1'], price: 1499990, productId: null }),
      ],
    });
    const where = clauses(builder);
    expect(where).toContain('source.id = :sourceId');
    expect(where).toContain('record."modelId" IS NULL');
    expect(builder['andWhere']).toHaveBeenCalledWith(expect.anything(), { search: '%haibike%' });
    expect(builder['offset']).toHaveBeenCalledWith(50);
    expect(builder['limit']).toHaveBeenCalledWith(25);
  });

  it('filters by seller, and only attached ones when asked', async () => {
    const builder = makeQueryBuilder({});

    await repositoryWith(builder).searchRecords({ sellerId: 'seller-1', attached: true });

    const where = clauses(builder);
    expect(where).toContain('source."sellerId" = :sellerId');
    expect(where).toContain('record."modelId" IS NOT NULL');
  });

  it('filters by several sources, validity, product name, brand and category', async () => {
    const builder = makeQueryBuilder({});

    await repositoryWith(builder).searchRecords({
      productSourceIds: ['source-1', 'source-2'],
      valid: false,
      productName: 'macina',
      brand: 'ktm',
      categoryIds: ['category-1'],
    });

    const where = clauses(builder);
    expect(where).toContain('source.id IN (:...sourceIds)');
    expect(where).toContain('record."specValid" IS FALSE');
    expect(where).toContain('model."displayName" ILIKE :productName');
    expect(where).toContain(`record."scrapedProduct" ->> 'brand' ILIKE :brand`);
    expect(where).toContain(`record."scrapedProduct" -> 'category' ->> 'id' IN (:...categoryIds)`);
    expect(builder['andWhere']).toHaveBeenCalledWith(expect.any(String), {
      sourceIds: ['source-1', 'source-2'],
    });
    expect(builder['andWhere']).toHaveBeenCalledWith(expect.any(String), { productName: '%macina%' });
    expect(builder['andWhere']).toHaveBeenCalledWith(expect.any(String), { brand: '%ktm%' });
  });

  it('counts a row written before validation existed as valid', async () => {
    const builder = makeQueryBuilder({});

    await repositoryWith(builder).searchRecords({ valid: true });

    expect(clauses(builder)).toContain('record."specValid" IS NOT FALSE');
  });

  it('puts the newest sighting first by default, and sorts text case-insensitively', async () => {
    const byDefault = makeQueryBuilder({});
    await repositoryWith(byDefault).searchRecords({});
    expect(byDefault['orderBy']).toHaveBeenCalledWith(
      'COALESCE(record."lastSeenAt", record."lastUpdated")',
      'DESC',
      'NULLS LAST',
    );

    const byProduct = makeQueryBuilder({});
    await repositoryWith(byProduct).searchRecords({ sort: 'productName', order: 'ASC' });
    expect(byProduct['orderBy']).toHaveBeenCalledWith('LOWER(model."displayName")', 'ASC', 'NULLS LAST');
    expect(byProduct['addOrderBy']).toHaveBeenCalledWith('record.id', 'ASC');
  });

  it('prices a listing by its cheapest entry, and reads a null validity as valid', async () => {
    const builder = makeQueryBuilder({
      getRawMany: [
        {
          id: 'record-1',
          offerExternalIds: null,
          offerCount: 3,
          price: '899990',
          priceWithoutDiscount: '999990',
          specValid: null,
        },
      ],
    });

    const { items } = await repositoryWith(builder).searchRecords({ sort: 'price' });

    expect(items[0]).toEqual(
      expect.objectContaining({
        offerExternalIds: [],
        offerCount: 3,
        price: 899990,
        priceWithoutDiscount: 999990,
        specValid: true,
      }),
    );
    expect(String(builder['orderBy'].mock.calls[0][0])).toContain(
      `ORDER BY (entry ->> 'price')::numeric ASC NULLS LAST LIMIT 1`,
    );
  });
});
