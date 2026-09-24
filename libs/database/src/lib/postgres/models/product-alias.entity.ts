import { Entity, Column, ManyToOne, Index, JoinColumn } from 'typeorm';
import { ProductModel } from './product-model.entity';
import { ProductSource } from './product-source.entity';
import { BasePostgresEntity } from './base-postgres-entity';
import { nameOf, SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';

export enum ProductAliasSource {
  scraped = 'scraped',
  auto_generated = 'auto_generated',
  manual = 'manual',
}

// Unique, so the scraper's ON CONFLICT DO NOTHING insert actually dedupes: one
// alias string once per product, while several products may share it.
@Entity()
@Index([nameOf<ProductAlias>('model'), nameOf<ProductAlias>('alias')], {
  unique: true,
})
export class ProductAlias extends BasePostgresEntity {
  @Index()
  // Trigram index for candidate recall. TypeORM can't declare a GIN operator
  // class, so it's created by hand once per environment, and
  // `synchronize: false` keeps sync from dropping it:
  // CREATE INDEX IF NOT EXISTS product_alias_alias_trgm_idx
  //   ON product_alias USING gin (alias gin_trgm_ops);
  @Index('product_alias_alias_trgm_idx', { synchronize: false })
  @Column()
  @Expose({ groups: [SerializeGroup.list] })
  alias: string;

  @Column({
    type: 'enum',
    enum: ProductAliasSource,
    default: ProductAliasSource.scraped,
  })
  @Expose({ groups: [SerializeGroup.list] })
  source: ProductAliasSource;

  @Column({ type: 'varchar', nullable: true })
  region?: string;

  // `disable`: saving a ProductModel with a loaded, stale aliases array must
  // never detach a row another writer attached meanwhile. TypeORM's default
  // (`nullify`) sets modelId to NULL on every row the array does not list.
  @ManyToOne(() => ProductModel, (model) => model.aliases, {
    onDelete: 'CASCADE',
    nullable: false,
    orphanedRowAction: 'disable',
  })
  model: ProductModel;

  @ManyToOne(() => ProductSource, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sourceRefId' })
  sourceRef?: ProductSource;

  @Column({ type: 'uuid', nullable: true })
  sourceRefId?: string;
}
