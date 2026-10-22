import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { FinderVisitor } from './finder-visitor.entity';

/**
 * A named set of finder answers a visitor saved, which the website scores the
 * products of its category against (on product pages and in lists).
 *
 * Written by fittkereso-frontend, like FinderVisitor (see there). This API only
 * deletes it, by cascade, when the retention job deletes its visitor.
 *
 * - **`answers`** is the finder's canonical answer string (`answersKey` in the
 *   website's recommender engine), re-read against the category's current
 *   `recommender.json` on every use, so a config change never invalidates it.
 * - **`activatedAt`**: a visitor's results of one category are scored by the
 *   one activated last (set on save and when the visitor picks one).
 * - **`category`** is the category slug, as the website's finder configs are
 *   keyed by it.
 */
@Entity()
// Leads with the visitor, so it serves the cascade delete too.
@Index([
  nameOf<FinderResult>('visitor'),
  nameOf<FinderResult>('category'),
  nameOf<FinderResult>('activatedAt'),
])
export class FinderResult extends BasePostgresEntity {
  @ManyToOne(() => FinderVisitor, { nullable: false, onDelete: 'CASCADE' })
  visitor: FinderVisitor;

  @Column({ type: 'varchar', nullable: false })
  category: string;

  @Column({ type: 'varchar', length: 60, nullable: false })
  name: string;

  @Column({ type: 'varchar', nullable: false })
  answers: string;

  @Column({ type: 'timestamptz', nullable: false })
  activatedAt: Date;
}
