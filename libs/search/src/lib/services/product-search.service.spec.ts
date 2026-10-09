import { OfferCondition } from '@fittkereso-backend/database';
import { ProductSearchService } from './product-search.service';

/** A query builder that records what the service asks of it. */
function fakeQueryBuilder() {
  const wheres: { sql: string; params?: Record<string, unknown> }[] = [];
  const joins: string[] = [];

  const subQuery = () => {
    const parts: string[] = [];
    const builder = {
      select: () => builder,
      from: (_entity: unknown, alias: string) => {
        parts.push(`FROM offer ${alias}`);
        return builder;
      },
      where: (sql: string) => {
        parts.push(sql);
        return builder;
      },
      andWhere: (sql: string) => {
        parts.push(sql);
        return builder;
      },
      getQuery: () => `(SELECT 1 ${parts.join(' AND ')})`,
    };
    return builder;
  };

  const query = {
    leftJoinAndSelect: (relation: string) => {
      joins.push(relation);
      return query;
    },
    leftJoin: (relation: string) => {
      joins.push(relation);
      return query;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      wheres.push({ sql, params });
      return query;
    },
    addSelect: () => query,
    orderBy: () => query,
    skip: () => query,
    take: () => query,
    subQuery,
    getManyAndCount: async (): Promise<[unknown[], number]> => [[], 0],
  };

  return { query, wheres, joins };
}

describe('ProductSearchService', () => {
  let recorded: ReturnType<typeof fakeQueryBuilder>;
  let service: ProductSearchService;

  beforeEach(() => {
    recorded = fakeQueryBuilder();
    service = new ProductSearchService(
      { repo: { createQueryBuilder: () => recorded.query } } as never,
      { getAllSlugs: () => [], getConfig: () => undefined } as never,
      { visibleCutoff: () => new Date('2026-09-23T06:30:00Z') } as never,
    );
  });

  describe('by GTIN', () => {
    // How it is printed on the box, and how it is stored.
    it.each(['9008594503199', '09008594503199', ' 9008594503199 '])(
      'finds %p as the stored GTIN-14',
      async (gtin) => {
        await service.searchProducts({ gtin });

        expect(recorded.wheres).toEqual([
          {
            sql: expect.stringMatching(
              /^EXISTS \(SELECT 1 FROM offer gtinOffer AND gtinOffer\.model = product\.id AND gtinOffer\.gtin = :gtin\)$/,
            ),
            params: { gtin: '09008594503199' },
          },
        ]);
      },
    );

    it('matches nothing for a value that is not a GTIN', async () => {
      // The check digit of 9008594503199, off by one.
      await service.searchProducts({ gtin: '9008594503198' });

      expect(recorded.wheres).toEqual([{ sql: '1 = 0', params: undefined }]);
    });

    it('ignores a blank value', async () => {
      await service.searchProducts({ gtin: '  ' });

      expect(recorded.wheres).toEqual([]);
    });
  });

  describe('by MPN', () => {
    it('matches a prefix, normalized the way an imported MPN is', async () => {
      await service.searchProducts({ mpn: 'mx 1260-040' });

      expect(recorded.wheres).toEqual([
        {
          sql: expect.stringContaining("mpnOffer.mpn LIKE :mpnPrefix ESCAPE '\\'"),
          params: { mpnPrefix: 'MX1260040%' },
        },
      ]);
    });

    it('takes LIKE wildcards in the value literally', async () => {
      await service.searchProducts({ mpn: 'AB_C%DE' });

      expect(recorded.wheres[0].params).toEqual({ mpnPrefix: 'AB\\_C\\%DE%' });
    });

    // No stored MPN is that short, so a shorter prefix would only ever be a
    // family of codes, which is not what the filter is for.
    it('matches nothing under 5 characters', async () => {
      await service.searchProducts({ mpn: '126' });

      expect(recorded.wheres).toEqual([{ sql: '1 = 0', params: undefined }]);
    });
  });

  describe('by offer condition', () => {
    // Unlike an identifier lookup, a stale used offer is no evidence the
    // product is for sale used now.
    it('matches a current offer in any of the conditions', async () => {
      await service.searchProducts({
        conditions: [OfferCondition.used, OfferCondition.refurbished],
      });

      expect(recorded.wheres).toEqual([
        {
          sql: expect.stringMatching(
            /^EXISTS \(SELECT 1 FROM offer conditionOffer AND conditionOffer\.model = product\.id AND conditionOffer\.condition IN \(:\.\.\.conditions\) AND conditionOffer\.lastSynced >= :offerFreshnessCutoff\)$/,
          ),
          params: {
            conditions: [OfferCondition.used, OfferCondition.refurbished],
            offerFreshnessCutoff: new Date('2026-09-23T06:30:00Z'),
          },
        },
      ]);
    });

    it('ignores an empty list', async () => {
      await service.searchProducts({ conditions: [] });

      expect(recorded.wheres).toEqual([]);
    });
  });

  describe('by an offer-level spec', () => {
    const CUTOFF = new Date('2026-09-23T06:30:00Z');

    beforeEach(() => {
      service = new ProductSearchService(
        { repo: { createQueryBuilder: () => recorded.query } } as never,
        {
          getAllSlugs: () => ['ebikes'],
          getConfig: () => ({ offerLevelSpecs: ['frameSize'] }),
        } as never,
        { visibleCutoff: () => CUTOFF } as never,
      );
    });

    // A stale offer's size is no evidence the product comes in it any more.
    it('matches current offers only', async () => {
      await service.searchProducts({ specFilters: { frameSize: 'M' } });

      expect(recorded.joins).toContain('product.offers');
      expect(recorded.wheres).toEqual([
        {
          sql: "offer.lastSynced >= :offerFreshnessCutoff AND offer.specs->>'frameSize' = :specFilterValue0",
          params: { offerFreshnessCutoff: CUTOFF, specFilterValue0: 'M' },
        },
      ]);
    });

    it('leaves a product-level spec alone', async () => {
      await service.searchProducts({ specFilters: { motorBrand: 'Bosch' } });

      expect(recorded.wheres).toEqual([
        {
          sql: "product.specs->>'motorBrand' = :specFilterValue0",
          params: { specFilterValue0: 'Bosch' },
        },
      ]);
    });
  });

  // A product with three matching sizes must stay one row, and one count.
  it('filters through a subquery, never by joining offers', async () => {
    await service.searchProducts({ gtin: '9008594503199', mpn: '1260040' });

    expect(recorded.joins).not.toContain('product.offers');
    expect(recorded.wheres.map((where) => where.sql)).toEqual([
      expect.stringMatching(/^EXISTS /),
      expect.stringMatching(/^EXISTS /),
    ]);
  });

  describe('with includeSources', () => {
    const listing = (sourceName: string) => ({
      id: `record-${sourceName}`,
      source: { id: `source-${sourceName}`, name: sourceName },
    });

    /** The page query returns `page`; the follow-up sources query returns
     *  `withSources` and records the ids it was asked for. */
    function serviceReturning(
      page: { id: string }[],
      withSources: { id: string; sources: unknown[] }[],
    ) {
      // Overridden in place: every chained call returns this same builder.
      const pageQuery = recorded.query;
      pageQuery.getManyAndCount = async () => [page, page.length];
      const sourcesQuery = {
        innerJoin: () => sourcesQuery,
        select: () => sourcesQuery,
        whereInIds: (ids: string[]) => {
          sourcesQuery.askedIds = ids;
          return sourcesQuery;
        },
        getMany: async () => withSources,
        askedIds: undefined as string[] | undefined,
      };
      const builders = [pageQuery, sourcesQuery];
      const searchService = new ProductSearchService(
        { repo: { createQueryBuilder: () => builders.shift() } } as never,
        { getAllSlugs: () => [], getConfig: () => undefined } as never,
        { visibleCutoff: () => new Date() } as never,
      );
      return { searchService, sourcesQuery };
    }

    it("attaches each product's listings, and none to a product without", async () => {
      const { searchService, sourcesQuery } = serviceReturning(
        [{ id: 'a' }, { id: 'b' }],
        [{ id: 'a', sources: [listing('speedbike'), listing('akosbike')] }],
      );

      const result = await searchService.searchProducts({
        includeSources: true,
      });

      expect(sourcesQuery.askedIds).toEqual(['a', 'b']);
      expect(result.items).toEqual([
        { id: 'a', sources: [listing('speedbike'), listing('akosbike')] },
        { id: 'b', sources: [] },
      ]);
    });

    it('skips the sources query for an empty page', async () => {
      const { searchService, sourcesQuery } = serviceReturning([], []);

      await searchService.searchProducts({ includeSources: true });

      expect(sourcesQuery.askedIds).toBeUndefined();
    });
  });
});
