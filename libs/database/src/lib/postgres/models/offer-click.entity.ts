import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { Seller } from './seller.entity';
import { OfferCondition } from '../types/offer-condition';

/**
 * One click on a "go to shop" button of the public website: the log a shop is
 * billed from. `createdAt` is the click time.
 *
 * Written by fittkereso-frontend, not by this API: its `/api/v1/out/{offerId}`
 * redirect inserts one row per click as the `fittkereso_click` database role
 * (SELECT and INSERT on this table only), and its partner portal reads the
 * shop's statistics from it. Renaming or dropping a column breaks recording.
 *
 * - **Every click is a row** — repeats and bots too. `billed` is decided at
 *   insert time and stored, so a later change to the rule never re-prices a
 *   click that was already billed: a click is billed when it is not a bot and
 *   the same visitor has no billed click on the same product at the same
 *   seller within the website's billing window (24 hours).
 * - **No foreign key to the offer or the product.** The stale-offer sweep
 *   deletes offers, and a product merge deletes the merged product with its
 *   offers; the log has to outlive both. The URL and price are kept as they were
 *   at the time of the click, and so are the category, brand, source and
 *   condition the shop filters its statistics by.
 * - **`visitorKey`** is a pseudonymous key (an HMAC of the visitor's IP and
 *   User-Agent with a secret only the website has). OfferClickRetentionService
 *   erases it once it is older than the billing window, after which a row is
 *   tied to no one.
 */
@Entity()
@Index([nameOf<OfferClick>('seller'), nameOf<OfferClick>('createdAt')])
// The billing check: this visitor's billed clicks on this product of this
// seller inside the window.
@Index(
  [
    nameOf<OfferClick>('seller'),
    nameOf<OfferClick>('modelId'),
    nameOf<OfferClick>('visitorKey'),
    nameOf<OfferClick>('createdAt'),
  ],
  { where: '"billed"' },
)
export class OfferClick extends BasePostgresEntity {
  @ManyToOne(() => Seller, { nullable: false, onDelete: 'CASCADE' })
  seller: Seller;

  @Column({ type: 'uuid', nullable: false })
  offerId: string;

  /** The ProductModel id. */
  @Column({ type: 'uuid', nullable: false })
  modelId: string;

  /** Where the visitor was sent. */
  @Column({ type: 'varchar', nullable: false })
  url: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: false })
  price: number;

  @Column({ type: 'varchar', nullable: false })
  currency: string;

  // What the shop's statistics filter on, as it was at the time of the click:
  // a product's category or brand can change and a merge deletes the product,
  // but a click keeps counting where it counted. No foreign keys, for the same
  // reason as offerId. Null on a click whose offer lacked it.

  /** The ProductCategory id. */
  @Column({ type: 'uuid', nullable: true })
  categoryId?: string | null;

  /** The Brand id. */
  @Column({ type: 'uuid', nullable: true })
  brandId?: string | null;

  /** The ProductSource whose listing supplied the offer. */
  @Column({ type: 'uuid', nullable: true })
  sourceId?: string | null;

  @Column({ type: 'enum', enum: OfferCondition, nullable: true })
  condition?: OfferCondition | null;

  /** Null once erased by the retention job. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  visitorKey?: string | null;

  @Column({ type: 'boolean', nullable: false })
  billed: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  bot: boolean;
}
