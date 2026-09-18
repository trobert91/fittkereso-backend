import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { Expose, Transform } from 'class-transformer';
import { SerializeGroup, nameOf, transfromExposeAll } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductSource } from './product-source.entity';
import { User } from './user.entity';
import { ProductSourceConfig } from '../types/product-source-config';
import { ProductSourceActorType } from '../types/product-source-actor';

/**
 * Every revision of a source's scraping config, oldest to newest, never rewritten.
 *
 * `ProductSource.config` stays the authority every scraper reads — the whole
 * pipeline works off `task.source.config` and none of it knows versions exist.
 * The newest row here always holds the same config as that column, written in
 * the same transaction, so the history includes the version in force rather
 * than only the superseded ones. That is what makes "show me v3" and "put v3
 * back" the same kind of query.
 *
 * There is deliberately NO `currentVersion` pointer on ProductSource. The
 * version in force is `max(version)`; a pointer would be a second claim about
 * which config is live, and two claims can disagree.
 *
 * Numbers start at 1, always increment, and are never reused or renumbered.
 * Restoring v2 while v5 is live writes v6 carrying v2's config — so the
 * sequence has no holes and no entry that changed meaning after the fact.
 *
 * Append-only by convention: ProductSourceVersionRepository exposes no update
 * and no delete. There is no database-level grant enforcing that here, unlike
 * a Supabase-backed schema, so the convention lives in the repository.
 */
@Entity()
@Unique([nameOf<ProductSourceVersion>('source'), nameOf<ProductSourceVersion>('version')])
@Index([nameOf<ProductSourceVersion>('source'), nameOf<ProductSourceVersion>('version')])
export class ProductSourceVersion extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => ProductSource, (source) => source.versions, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @Index()
  source: ProductSource;

  /**
   * The revision number, unique per source.
   *
   * The UNIQUE constraint above is the concurrency guarantee, not the
   * `max(version) + 1` the service computes. Two saves racing both read the
   * same maximum; the constraint is what turns the second into a violation to
   * retry instead of two rows claiming v4.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'int', nullable: false })
  version: number;

  /**
   * The whole config as it was at this revision, not a diff against the last.
   *
   * adminDetails only, so a page of the history does not carry one complete
   * scrape config per row — they are large, and a reader is looking at one at
   * a time. The single-version route is what serves it.
   */
  @Expose({ groups: [SerializeGroup.adminDetails] })
  @Column({ type: 'jsonb', nullable: false })
  @Transform(transfromExposeAll())
  config: ProductSourceConfig;

  /** Why this revision exists, in the author's words. Blank is the ordinary case. */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: false, default: '' })
  note: string;

  /**
   * The version this one was copied from, when it came from a restore rather
   * than an edit. The number rather than a row reference: (source, version) is
   * unique and rows are never deleted except with their source, so the number
   * always resolves — and it is what the history actually displays.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'int', nullable: true })
  restoredFromVersion?: number | null;

  /**
   * Whether a person wrote this or the machine did.
   *
   * Carried separately from `actorUser` because a null user is overloaded: it
   * means both "a scheduled job did this" and "a person did this and their
   * account was later deleted". Attributing a deleted admin's work to the
   * machine is a wrong answer, which is worse than a blank one in a record
   * that exists to say who did what.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'text', nullable: false, default: 'system' })
  actorType: ProductSourceActorType;

  /**
   * Who wrote this revision, when a person did.
   *
   * `SET NULL` rather than restricting: an account must be deletable, and this
   * is a historical fact that has to survive the deletion. `actorLabel` below
   * is what keeps answering once the link is gone — the arrangement
   * UserDeleteService's comment asks history rows to use.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actorUser?: User | null;

  /**
   * The actor's email, frozen at write time.
   *
   * Denormalised on purpose: the FK above goes null when an account is
   * deleted, and a history that then cannot name who acted has stopped being
   * a history. Reads prefer the live user and fall back to this.
   */
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.adminDetails] })
  @Column({ type: 'varchar', nullable: true })
  actorLabel?: string | null;
}
