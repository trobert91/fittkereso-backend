import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose } from 'class-transformer';
import type {
  SpecDefinitionJsonSchema,
  SpecDefinitionUiSchema,
} from '../../models/product-spec';

@Entity()
export class ProductCategory extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminDetails] })
  jsonSchema?: SpecDefinitionJsonSchema;

  @Expose({ groups: [SerializeGroup.adminDetails] })
  uiSchema?: SpecDefinitionUiSchema;

  @Index()
  @Column({ unique: true })
  @Expose({ groups: [SerializeGroup.list] })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: false, unique: true })
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.adminDetails] })
  slug: string;

  @Index()
  @Column({ nullable: false, default: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  enabled: boolean;

  @Column({ nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  extractionEnabled: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  searchEnabled: boolean;

  @Column({ type: 'smallint', nullable: false, default: 5 })
  @Expose({ groups: [SerializeGroup.adminList] })
  searchPriority: number;

  @Index()
  @Column({ type: 'boolean', nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  autoDeduplicationEnabled: boolean;

  @OneToMany(() => ProductModel, (model) => model.productCategory)
  models: ProductModel[];

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  aliases?: string[];
}
