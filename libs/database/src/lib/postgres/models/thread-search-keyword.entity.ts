import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from "typeorm";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { BasePostgresEntity } from "./base-postgres-entity";
import { ProductCategory } from "./product-category.entity";
import { ThreadPlatform } from "../types/source-enums";

/**
 * Cooldown record for the keyword-research pipeline. One row per
 * (keyword, platform, category) tuple the orchestrator has searched at least
 * once. `lastSearchedAt` is updated on every search; the orchestrator filters
 * keywords whose row is within the configured cooldown window.
 *
 * Cooldown is keyword-level — even though the orchestrator fans out per
 * subreddit, the planner-generated keywords are the unit that needs throttling.
 *
 * All performance stats (yield, relevance, rejection counts) live on
 * `Thread.keywords` and are derived on the fly — this table intentionally
 * does NOT maintain any aggregate counters.
 */
@Entity()
@Unique("UQ_thread_search_keyword_keyword_platform_category", [
  "keyword",
  "platform",
  "categoryId",
])
export class ThreadSearchKeyword extends BasePostgresEntity {
  @Column({ type: "varchar" })
  @Expose({ groups: [SerializeGroup.list] })
  keyword: string;

  @Index()
  @Column({ type: "enum", enum: ThreadPlatform })
  @Expose({ groups: [SerializeGroup.list] })
  platform: ThreadPlatform;

  @ManyToOne(() => ProductCategory)
  @JoinColumn({ name: "categoryId", referencedColumnName: "id" })
  @Expose({ groups: [SerializeGroup.adminList] })
  category: ProductCategory;

  @Index()
  @Column({ type: "uuid" })
  @Expose({ groups: [SerializeGroup.list] })
  categoryId: string;

  @Index()
  @Column({ type: "timestamptz", default: () => "now()" })
  @Expose({ groups: [SerializeGroup.list] })
  lastSearchedAt: Date;
}
