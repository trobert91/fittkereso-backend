import 'reflect-metadata';
import {
  ProductResolution,
  ProductResolutionRepository,
  ProductResolutionStatus,
} from '@fittkereso-backend/database';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { ProductResolutionSearchParams } from '../models/product-resolution-search-params';
import { ProductResolutionSearchService } from './product-resolution-search.service';

/**
 * These build real TypeORM metadata and a real query builder — no database
 * connection, but no hand-rolled query-builder mock either.
 *
 * That matters because the bug these cover was invisible to a mock: TypeORM
 * only rewrites a query into a DISTINCT subquery when `skip`/`take` are set,
 * and only then does it parse each ORDER BY term as `alias.property`. An
 * expression written inline into ORDER BY therefore passed every unit test and
 * failed on the first paginated request against Postgres.
 */
describe('ProductResolutionSearchService', () => {
  let dataSource: DataSource;
  let service: ProductResolutionSearchService;

  beforeAll(async () => {
    // Every class decorated with @Entity() that the database barrel imported.
    const entities = getMetadataArgsStorage().tables.map(
      (table) => table.target,
    ) as (string | (new () => unknown))[];

    dataSource = new DataSource({ type: 'postgres', entities });
    // Builds metadata without connecting — enough for SQL generation.
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  beforeEach(() => {
    const repo = {
      repo: {
        createQueryBuilder: (alias: string) =>
          dataSource.createQueryBuilder(ProductResolution, alias),
      },
    };
    service = new ProductResolutionSearchService(
      repo as unknown as ProductResolutionRepository,
    );
  });

  /** The query `search()` would run, built through the private path so the
   *  ordering under test is the one production uses. */
  const buildPaginatedQuery = (
    params: ProductResolutionSearchParams = {},
  ): SelectQueryBuilder<ProductResolution> => {
    const query = (
      service as unknown as {
        buildQuery(
          params: ProductResolutionSearchParams,
        ): SelectQueryBuilder<ProductResolution>;
      }
    ).buildQuery(params);
    return query.skip(0).take(50);
  };

  /** The exact call `getManyAndCount` makes on a paginated query, and the one
   *  that threw `"(resolution" alias was not found`. */
  const resolveOrderByForPagination = (
    query: SelectQueryBuilder<ProductResolution>,
  ) =>
    (
      query as unknown as {
        createOrderByCombinedWithSelectExpression(
          parentAlias: string,
        ): [string, Record<string, unknown>];
      }
    ).createOrderByCombinedWithSelectExpression('distinctAlias');

  describe('ordering', () => {
    it('resolves the default priority order on a paginated query', () => {
      const query = buildPaginatedQuery();

      expect(() => resolveOrderByForPagination(query)).not.toThrow();
    });

    it('resolves an explicit sort column on a paginated query', () => {
      const query = buildPaginatedQuery({
        sortBy: 'similarityScore',
        sortDir: 'ASC',
      });

      expect(() => resolveOrderByForPagination(query)).not.toThrow();
    });

    it('leads on priority by default', () => {
      const orderBy = buildPaginatedQuery().expressionMap.allOrderBys;

      expect(Object.keys(orderBy)[0]).toBe('resolution.priority');
      // An unscored row is unknown, not urgent — it sorts last, never first.
      expect(orderBy['resolution.priority']).toEqual({
        order: 'DESC',
        nulls: 'NULLS LAST',
      });
      expect(orderBy['resolution.createdAt']).toBe('DESC');
    });

    it('orders on a real column, with no computed rank left', () => {
      // The old default projected a `CASE WHEN status = 'pending'` rank because
      // the schema could not express review order. A stored column both sorts
      // better and removes the expression that broke the paginated path.
      const sql = buildPaginatedQuery().getQuery();

      expect(sql).not.toContain('resolution_review_rank');
      expect(sql).not.toContain('CASE WHEN');
    });

    it('never emits an order-by term whose alias prefix does not exist', () => {
      // The invariant behind the bug, checked directly: TypeORM reads
      // everything before the first dot as an alias name.
      for (const params of [
        {},
        { sortBy: 'priority' as const },
        { sortBy: 'similarityScore' as const },
        { sortBy: 'decisionConfidence' as const },
        { sortBy: 'createdAt' as const },
        { sortBy: 'lastSeenAt' as const },
      ]) {
        const query = buildPaginatedQuery(params);

        for (const criteria of Object.keys(query.expressionMap.allOrderBys)) {
          if (!criteria.includes('.')) continue;
          const aliasName = criteria.split('.')[0];
          expect(() =>
            query.expressionMap.findAliasByName(aliasName),
          ).not.toThrow();
        }
      }
    });
  });

  describe('filtering', () => {
    it('defaults to the open statuses, so the queue shows work and not history', () => {
      const query = buildPaginatedQuery();

      expect(query.getParameters()['statuses']).toEqual([
        ProductResolutionStatus.pending,
        ProductResolutionStatus.failed,
      ]);
    });

    it('uses the requested statuses when given', () => {
      const query = buildPaginatedQuery({
        statuses: [ProductResolutionStatus.done],
      });

      expect(query.getParameters()['statuses']).toEqual([
        ProductResolutionStatus.done,
      ]);
    });

    it('matches a product across every role it can play on a row', () => {
      const query = buildPaginatedQuery({ productId: 'product-1' });
      const sql = query.getQuery();

      expect(sql).toContain('"productA"."id" = :productId');
      expect(sql).toContain('"productB"."id" = :productId');
      expect(sql).toContain('"resolvedProduct"."id" = :productId');
      // Where the reviewed listing actually sits now.
      expect(sql).toContain('"listingProduct"."id" = :productId');
    });

    it('joins the listing and the product it currently sits on', () => {
      const sql = buildPaginatedQuery().getQuery();

      expect(sql).toContain('sourceRecord');
      expect(sql).toContain('listingSource');
      expect(sql).toContain('listingProduct');
    });

    it('lets a reviewer work a priority band', () => {
      const query = buildPaginatedQuery({ minPriority: 60 });

      expect(query.getQuery()).toContain('"resolution"."priority" >= :minPriority');
      expect(query.getParameters()['minPriority']).toBe(60);
    });

    it('applies no priority floor unless asked, so nothing vanishes silently', () => {
      expect(buildPaginatedQuery().getQuery()).not.toContain(':minPriority');
    });
  });
});
