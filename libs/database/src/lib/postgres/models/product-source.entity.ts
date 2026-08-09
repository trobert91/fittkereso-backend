import { Column, Entity, Index, OneToMany } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { ProductSourceType } from "../types/product-source";
import { ScrapeTask } from "./scrape-task.entity";
import { ProductImage } from "./product-image.entity";
import ms from "ms";

@Entity()
export class ProductSource extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  @Column({ unique: true })
  name: string;

  @Expose({ groups: [SerializeGroup.list] })
  @Column({ type: "enum", enum: ProductSourceType, nullable: false })
  type: ProductSourceType;

  @OneToMany(() => ScrapeTask, (task) => task.source)
  tasks: ScrapeTask[];

  @OneToMany(() => ProductImage, (image) => image.source)
  images: ProductImage[];

  @Column({ type: "timestamptz", nullable: true })
  lastRunAt?: Date;

  @Column({ type: "int", nullable: false, default: 1 })
  maxConcurrent: number;

  @Column({ type: "int", nullable: false, default: 60 })
  requestsPerHour: number;

  @Column({ type: "int", nullable: false, default: 10 })
  priority: number;

  @Index()
  @Column({ nullable: false, default: true })
  schedulingEnabled: boolean;

  @Column({ nullable: false, default: true })
  processingEnabled: boolean;

  @Column({ type: "text", nullable: true })
  fullSyncInterval?: ms.StringValue;

  @Column({ type: "timestamptz", nullable: true })
  nextFullSyncAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastFullSyncAt?: Date;

  @Column({ type: "text", nullable: true })
  incrementalSyncInterval?: ms.StringValue;

  @Column({ type: "timestamptz", nullable: true })
  nextIncrementalSyncAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastIncrementalSyncAt?: Date;
}
