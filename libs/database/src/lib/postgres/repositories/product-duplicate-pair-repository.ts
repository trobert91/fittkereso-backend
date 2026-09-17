import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, LessThan, Not, Repository } from 'typeorm';
import { groupBy, isEmpty, orderBy, sortBy } from 'lodash';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductDuplicatePair } from '../models/product-duplicate-pair.entity';
import type { DuplicatePairRow } from '../types/product-duplicate-pair.types';

const column = (field: keyof ProductDuplicatePair): string =>
  `"${nameOf<ProductDuplicatePair>(field)}"`;

/** The columns `upsertPairs` inserts, in VALUES order. */
const INSERTED: (keyof DuplicatePairRow)[] = [
  'productAId',
  'productBId',
  'similarityScore',
  'matchedOn',
  'matchedValue',
  'failedGates',
  'nameSimilarity',
  'detectedBy',
];

/** What a new detection refreshes on an open pair; `detectedBy` stays. */
const REFRESHED: (keyof DuplicatePairRow)[] = [
  'similarityScore',
  'matchedOn',
  'matchedValue',
  'failedGates',
  'nameSimilarity',
];

@Injectable()
export class ProductDuplicatePairRepository extends BasePostgresRepository<ProductDuplicatePair> {
  constructor(
    @InjectRepository(ProductDuplicatePair, 'postgres')
    repository: Repository<ProductDuplicatePair>,
  ) {
    super(repository, ProductDuplicatePair);
  }

  /**
   * Inserts new pairs and refreshes open ones, bumping `updatedAt` even when
   * nothing changed (the scan's stale cleanup relies on it). A dismissed pair
   * is left exactly as it is, so a person's "not duplicates" survives every
   * later detection. Returns the rows written; dismissed conflicts don't count.
   */
  public async upsertPairs(
    rows: DuplicatePairRow[],
    manager?: EntityManager,
  ): Promise<number> {
    const ordered = orderPairRows(rows);
    if (isEmpty(ordered)) return 0;

    const table = this.table();
    const params: unknown[] = [];
    const values = ordered.map((row) => {
      const base = params.length;
      params.push(
        row.productAId,
        row.productBId,
        row.similarityScore,
        row.matchedOn,
        row.matchedValue,
        // Stringified: node-postgres would send a JS array as a Postgres array, not JSON.
        JSON.stringify(row.failedGates),
        row.nameSimilarity ? JSON.stringify(row.nameSimilarity) : null,
        row.detectedBy,
      );
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::int, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::jsonb, $${base + 8})`;
    });

    const written: unknown[] = await (manager ?? this.repo.manager).query(
      `INSERT INTO ${table} (${INSERTED.map(column).join(', ')})
       VALUES ${values.join(', ')}
       ON CONFLICT (${column('productAId')}, ${column('productBId')}) DO UPDATE SET
         ${REFRESHED.map((field) => `${column(field)} = EXCLUDED.${column(field)}`).join(', ')},
         ${column('updatedAt')} = now()
       WHERE ${table}.${column('dismissedAt')} IS NULL
       RETURNING ${column('id')}`,
      params,
    );
    return written.length;
  }

  /** Dismisses an open pair. False when there's no such pair or it was already dismissed. */
  public async dismiss(id: string): Promise<boolean> {
    const result = await this.repo.update(
      { id, dismissedAt: IsNull() },
      { dismissedAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Reopens a dismissed pair — someone changed their mind. False when there's
   * no such pair or it was already open.
   *
   * `updatedAt` moves to now with it (`@UpdateDateColumn`), which matters: a
   * complete scan deletes open pairs it didn't re-find, and a pair dismissed
   * months ago would otherwise be swept away by the next one before anybody
   * looked at it again.
   */
  public async reopen(id: string): Promise<boolean> {
    const result = await this.repo.update(
      { id, dismissedAt: Not(IsNull()) },
      { dismissedAt: null },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Keeps a merge from reopening what a person already dismissed. For every
   * dismissed pair between the product being merged away and some product X
   * other than the target, the target gets a dismissed pair with X; an existing
   * (target, X) pair is dismissed too, keeping its own date if it had one.
   *
   * Runs inside the merge transaction, before the source is deleted — the
   * delete cascades the source's own pairs away. The carried row keeps the old
   * pair's score and match but not its gates: those compared the merged-away
   * product, not the target.
   */
  public async carryDismissalsForMerge(
    manager: EntityManager,
    sourceId: string,
    targetId: string,
  ): Promise<number> {
    const table = this.table();
    const productA = column('productAId');
    const productB = column('productBId');
    const dismissedAt = column('dismissedAt');

    const written: unknown[] = await manager.query(
      `INSERT INTO ${table} (${productA}, ${productB}, ${column('similarityScore')}, ${column('matchedOn')}, ${column('matchedValue')}, ${column('failedGates')}, ${column('detectedBy')}, ${dismissedAt})
       SELECT LEAST($2::uuid, other.id), GREATEST($2::uuid, other.id),
              pair.${column('similarityScore')}, pair.${column('matchedOn')}, pair.${column('matchedValue')},
              '[]'::jsonb, 'merge', pair.${dismissedAt}
       FROM ${table} AS pair
       CROSS JOIN LATERAL (
         SELECT CASE WHEN pair.${productA} = $1::uuid THEN pair.${productB} ELSE pair.${productA} END AS id
       ) AS other
       WHERE pair.${dismissedAt} IS NOT NULL
         AND $1::uuid IN (pair.${productA}, pair.${productB})
         AND other.id <> $2::uuid
       ON CONFLICT (${productA}, ${productB}) DO UPDATE SET
         ${dismissedAt} = COALESCE(${table}.${dismissedAt}, EXCLUDED.${dismissedAt}),
         ${column('updatedAt')} = now()
       RETURNING ${column('id')}`,
      [sourceId, targetId],
    );
    return written.length;
  }

  /** Deletes open pairs not refreshed since `before`. Dismissed pairs are never deleted. */
  public async deleteStaleOpenPairs(before: Date): Promise<number> {
    const result = await this.repo.delete({
      dismissedAt: IsNull(),
      updatedAt: LessThan(before),
    });
    return result.affected ?? 0;
  }

  private table(): string {
    return `"${this.repo.metadata.tableName}"`;
  }
}

/**
 * The rows `upsertPairs` writes: ids lowercased (the order Postgres sorts
 * uuids in), one row per pair keeping the highest score, sorted by (A, B) so
 * concurrent writers lock rows in the same order and can't deadlock. Throws on
 * a row whose ids aren't ordered A < B.
 */
export function orderPairRows(rows: DuplicatePairRow[]): DuplicatePairRow[] {
  const lowercased = rows.map((row) => ({
    ...row,
    productAId: row.productAId.toLowerCase(),
    productBId: row.productBId.toLowerCase(),
  }));

  const unordered = lowercased.find((row) => row.productAId >= row.productBId);
  if (unordered) {
    throw new Error(
      `Duplicate pair ids must be ordered A < B: ${unordered.productAId}, ${unordered.productBId}`,
    );
  }

  const best = Object.values(
    groupBy(lowercased, (row) => `${row.productAId}:${row.productBId}`),
  ).map((group) => orderBy(group, (row) => row.similarityScore, 'desc')[0]);

  return sortBy(best, [(row) => row.productAId, (row) => row.productBId]);
}
