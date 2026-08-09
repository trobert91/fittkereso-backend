import { Column, Entity, ManyToOne } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { ProductModel } from "./product-model.entity";
import { ProductSource } from "./product-source.entity";

@Entity()
export class ProductImage extends BasePostgresEntity {
  @ManyToOne(() => ProductModel, (model) => model.images, {
    nullable: false,
    onDelete: "CASCADE",
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  @ManyToOne(() => ProductSource, (source) => source.images, {
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
