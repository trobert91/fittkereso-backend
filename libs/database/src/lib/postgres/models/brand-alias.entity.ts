import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { Expose } from 'class-transformer';
import { BasePostgresEntity } from './base-postgres-entity';
import { Brand } from './brand.entity';
import { nameOf, SerializeGroup } from '@fittkereso-backend/utils';

export enum BrandAliasSource {
  manual = 'manual',
  correction = 'correction',
  auto_generated = 'auto_generated',
}

@Entity()
@Unique([nameOf<BrandAlias>('alias')])
export class BrandAlias extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list] })
  @Index()
  @Column()
  alias: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({
    type: 'enum',
    enum: BrandAliasSource,
    default: BrandAliasSource.manual,
  })
  source: BrandAliasSource;

  @Index()
  @ManyToOne(() => Brand, (brand) => brand.aliases, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  brand: Brand;
}
