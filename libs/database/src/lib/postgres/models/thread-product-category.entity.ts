import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { Thread } from "./thread.entity";
import { ProductCategory } from "./product-category.entity";
import { SerializeGroup } from "@ebike-backend/utils";
import { Exclude, Expose, Type } from "class-transformer";

@Index(["thread", "productCategory"], { unique: true })
@Entity()
export class ThreadProductCategory extends BasePostgresEntity {
  @ManyToOne(() => Thread, (thread) => thread.categories, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "thread_id" })
  @Exclude()
  thread: Thread;

  @ManyToOne(() => ProductCategory, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "category_id" })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Type(() => ProductCategory)
  productCategory: ProductCategory;

  @Column({ type: "int", nullable: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  confidence: number;

  @Column({ type: "int", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList] })
  rank: number;
}
