import { isEmpty } from 'lodash';
import type { ObjectLiteral, Repository } from 'typeorm';

/**
 * How many rows point at each of the given parents, in one query.
 *
 * The alternative — counting per parent — is the N+1 that makes any
 * whole-table sweep unusable, so this exists to make the batched shape the easy
 * one to reach for. Parents with no rows are simply absent from the map rather
 * than present with `0`; callers default them.
 */
export async function countByRelationIds<T extends ObjectLiteral>(
  repo: Repository<T>,
  relationProperty: string,
  parentIds: string[],
): Promise<Map<string, number>> {
  if (isEmpty(parentIds)) return new Map();

  const joinColumn = repo.metadata
    .findRelationWithPropertyPath(relationProperty)
    ?.joinColumns[0]?.databaseName;

  if (!joinColumn) {
    throw new Error(
      `${repo.metadata.name} has no join column for relation "${relationProperty}"`,
    );
  }

  const rows = await repo
    .createQueryBuilder('row')
    // The FK column, not the relation — selecting the relation would join the
    // parent table for ids we already hold.
    .select(`"row"."${joinColumn}"`, 'parentId')
    .addSelect('COUNT(*)', 'total')
    .where(`"row"."${joinColumn}" IN (:...parentIds)`, { parentIds })
    .groupBy(`"row"."${joinColumn}"`)
    .getRawMany<{ parentId: string; total: string }>();

  return new Map(rows.map((row) => [row.parentId, Number(row.total)]));
}
