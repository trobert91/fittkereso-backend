import { Column, Entity, ManyToOne } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { ProductModel } from './product-model.entity';
import { ProductSource } from './product-source.entity';

@Entity()
export class ProductImage extends BasePostgresEntity {
  // `disable`: saving a ProductModel with a loaded, stale images array must
  // never detach a row another writer attached meanwhile. TypeORM's default
  // (`nullify`) sets modelId to NULL on every row the array does not list.
  @ManyToOne(() => ProductModel, (model) => model.images, {
    nullable: false,
    onDelete: 'CASCADE',
    orphanedRowAction: 'disable',
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  @ManyToOne(() => ProductSource, {
    nullable: true,
  })
  source?: ProductSource;

  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ nullable: true, unique: true })
  @Expose({ groups: [SerializeGroup.list] })
  url?: string;

  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  fileName: string;

  @Column({ unique: false, nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  sourceUrl?: string;

  @Column()
  @Expose({ groups: [SerializeGroup.details] })
  order: number;
}
