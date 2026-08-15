import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import { ProductSource } from './product-source.entity';
import { ProductSpecs } from '../../models/product-spec';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';

@Entity()
@Index(['model', 'source'])
export class ProductModelSource extends BasePostgresEntity {
  @ManyToOne(() => ProductModel, (model) => model.sources, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSource, { nullable: true, onDelete: 'SET NULL' })
  @Index()
  source?: ProductSource | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true, unique: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  url?: string;

  @Column({ type: 'jsonb', nullable: false, default: '{}' })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Transform(transfromExposeAll())
  specs: ProductSpecs;

  @Column({ nullable: true, default: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  specValid?: boolean;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Transform(transfromExposeAll())
  specErrors?: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  lastUpdated: Date;

  @Column({ type: 'boolean', nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  deduplicated: boolean;

  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  sourceName?: string;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  normalizedSourceName?: string;
}
