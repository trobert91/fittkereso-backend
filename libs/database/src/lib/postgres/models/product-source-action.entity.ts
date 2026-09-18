import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, nameOf, transfromExposeAll } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductSource } from './product-source.entity';
import { User } from './user.entity';
import { ProductSourceActionType } from '../types/product-source-action';
import { ProductSourceActorType } from '../types/product-source-actor';

/**
 * A product source's append-only audit trail: what happened to it, when, and
 * who did it.
 *
 * The twin of ProductSourceVersion rather than a replacement for it. A version
 * is the thing the next scrape will execute; this is the record that something
 * happened. Keeping them apart is why a `config_version_created` row carries a
 * version NUMBER and not a config — see ProductSourceActionType.
 *
 * It exists because a config that scrapes nothing is usually a config somebody
 * changed, and "who changed what, and when" is a question the source row alone
 * can never answer — it holds only the current state.
 *
 * Append-only by convention: ProductSourceActionRepository exposes insert and
 * reads, and no update or delete. A correction is a new row.
 */
@Entity()
@Index([nameOf<ProductSourceAction>('source'), nameOf<ProductSourceAction>('occurredAt')])
@Index([nameOf<ProductSourceAction>('source'), nameOf<ProductSourceAction>('type')])
export class ProductSourceAction extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSource, (source) => source.actions, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  source: ProductSource;

  /** What happened. Narrowed by ProductSourceActionType at every write. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: false })
  type: ProductSourceActionType;

  /**
   * What the entry says beyond its type — see ProductSourceActionType for the
   * shape each one carries.
   *
   * Labels are frozen in here rather than joined at render time, for the
   * reason actorLabel is: a timeline has to stay readable after the rows it
   * referenced are gone, and it should not need a join per row to name things.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: false, default: '{}' })
  @Transform(transfromExposeAll())
  payload: Record<string, unknown>;

  /** Whether a person did this or the machine did. See ProductSourceActorType. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: false, default: 'system' })
  actorType: ProductSourceActorType;

  /** Who acted, while their account exists. Nulled rather than blocking a deletion. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actorUser?: User | null;

  /** Their email, frozen at write time, so a deletion leaves the trail readable. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  actorLabel?: string | null;

  /**
   * When the thing happened, which is not always when the row was written.
   *
   * The ordering key, and the reason there is an index on (source,
   * occurredAt): `createdAt` from the base entity records when we wrote it
   * down. The two differ whenever something is recorded after the fact, and a
   * timeline ordered by the wrong one shows events out of sequence.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Index()
  @Column({ type: 'timestamptz', nullable: false })
  occurredAt: Date;
}
