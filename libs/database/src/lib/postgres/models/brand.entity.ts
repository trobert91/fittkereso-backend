import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { Expose } from 'class-transformer';
import { ProductModel } from './product-model.entity';
import { BrandAlias } from './brand-alias.entity';
import { SerializeGroup } from '@fittkereso-backend/utils';

@Entity()
export class Brand extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  name: string;

  @OneToMany(() => ProductModel, (model) => model.brand)
  models: ProductModel[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @OneToMany(() => BrandAlias, (alias) => alias.brand)
  aliases: BrandAlias[];

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  slug?: string | null;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: true })
  domains?: string[];
}
