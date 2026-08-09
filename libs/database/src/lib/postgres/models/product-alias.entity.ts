import { Entity, Column, ManyToOne, Index, JoinColumn } from "typeorm";
import { ProductModel } from "./product-model.entity";
import { ProductSource } from "./product-source.entity";
import { BasePostgresEntity } from "./base-postgres-entity";
import { nameOf, SerializeGroup } from "@ebike-backend/utils";
import { Expose } from "class-transformer";

export enum ProductAliasSource {
  scraped = "scraped",
  auto_generated = "auto_generated",
  manual = "manual",
}

@Entity()
@Index([nameOf<ProductAlias>("model"), nameOf<ProductAlias>("alias")])
export class ProductAlias extends BasePostgresEntity {
  @Index()
  @Column()
  @Expose({ groups: [SerializeGroup.list] })
  alias: string;

  @Column({
    type: "enum",
    enum: ProductAliasSource,
    default: ProductAliasSource.scraped,
  })
  @Expose({ groups: [SerializeGroup.list] })
  source: ProductAliasSource;

  @Column({ type: "varchar", nullable: true })
  region?: string;

  @ManyToOne(() => ProductModel, (model) => model.aliases, {
    onDelete: "CASCADE",
    nullable: false,
  })
  model: ProductModel;

  @ManyToOne(() => ProductSource, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "sourceRefId" })
  sourceRef?: ProductSource;

  @Column({ type: "uuid", nullable: true })
  sourceRefId?: string;
}
