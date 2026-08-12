import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  Unique,
} from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductCategory } from './product-category.entity';
import { ProductAlias } from './product-alias.entity';
import { ProductEmbedding } from './product-embedding.entity';
import { Brand } from './brand.entity';
import { OrderedSpec, ProductSpecs } from '../../models/product-spec';
import { ProductModelSource } from './product-model-source.entity';
import { ProductImage } from './product-image.entity';
import { ScrapeTask } from './scrape-task.entity';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';
import { Expose, Transform } from 'class-transformer';

@Entity()
@Index(['productCategory', 'enabled'])
@Unique('UQ_product_brand_normalized_name', ['brand', 'normalizedName'])
export class ProductModel extends BasePostgresEntity {
  @ManyToOne(() => Brand, (brand) => brand.models, { nullable: false })
  @Expose({ groups: [SerializeGroup.list] })
  brand: Brand;

  @Index()
  @Column({ nullable: false, unique: true })
  @Expose({ groups: [SerializeGroup.list] })
  displayName: string;

  @Index()
  @Column({ nullable: false })
  @Expose({ groups: [SerializeGroup.list] })
  model: string;

  @Index()
  @Column({ nullable: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  normalizedName: string;

  @Column({ type: 'text', nullable: true })
  @Expose({ groups: [SerializeGroup.details] })
  description: string;

  @ManyToOne(() => ProductCategory, (type) => type.models, { nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  productCategory?: ProductCategory;

  @OneToMany(() => ProductAlias, (alias) => alias.model, { cascade: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  aliases?: ProductAlias[];

  @OneToMany(() => ProductModelSource, (source) => source.model, {
    cascade: true,
    eager: false,
  })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  sources: ProductModelSource[];

  /**
   * All product specifications stored as a JSONB object.
   * Example:
   * {
   *   "Panel Type": "IPS",
   *   "Refresh Rate": 165,
   *   "Resolution": "2560x1440",
   *   "Size": 27
   * }
   */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.details] })
  @Transform(transfromExposeAll())
  specs?: ProductSpecs;

  /**
   * Ordered specifications according to specDefinitions.order with units
   */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.list] })
  @Transform(transfromExposeAll())
  orderedSpecs?: OrderedSpec[];

  @Column({ nullable: false, default: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  specValid?: boolean;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Transform(transfromExposeAll())
  specErrors?: Record<string, any>;

  @OneToOne(() => ProductImage, (image) => image.model, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn()
  @Expose({ groups: [SerializeGroup.list] })
  mainImage?: ProductImage | null;

  @OneToMany(() => ProductImage, (image) => image.model)
  @Expose({ groups: [SerializeGroup.details] })
  images: ProductImage[];

  @OneToMany(() => ScrapeTask, (task) => task.product)
  @Expose({ groups: [SerializeGroup.adminDetails] })
  scrapeTasks?: ScrapeTask[];

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.adminList] })
  slug?: string | null;

  @Index()
  @Column({ nullable: false, default: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  enabled: boolean;

  @Column({ type: 'int', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.details] })
  releaseYear?: number;

  @OneToOne(() => ProductEmbedding, {
    onDelete: 'SET NULL',
    nullable: false,
    cascade: true,
  })
  @JoinColumn()
  embedding?: ProductEmbedding;
}
