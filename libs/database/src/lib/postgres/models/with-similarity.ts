import { BasePostgresEntity } from './base-postgres-entity';

export interface WithSimilarity<T extends Partial<BasePostgresEntity>> {
  entity: T;
  similarity: number;
}
