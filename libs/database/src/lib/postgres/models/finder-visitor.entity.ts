import { Column, Entity, Index } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';

/**
 * A visitor of the public website who saved a finder result (the guided product
 * finder): what their saved results hang off. There is no account, no IP and no
 * User-Agent; the visitor is known only by a random key kept in a cookie.
 *
 * Written by fittkereso-frontend, not by this API: its `/api/v1/finder/*`
 * routes create, read, update and delete it as the `fittkereso_finder` database
 * role (full access to this table and FinderResult only). Renaming or dropping a
 * column breaks saving.
 *
 * - **`keyHash`** is the SHA-256 (hex) of the cookie's key. The key itself is
 *   never stored, so the table cannot be replayed as cookies.
 * - **`lastSeenAt`** is refreshed by the website at most once a day when the
 *   visitor's scores are asked for. FinderRetentionService deletes the visitors
 *   not seen for `finder.json` `retentionDays`, and their results with them.
 */
@Entity()
export class FinderVisitor extends BasePostgresEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: false })
  keyHash: string;

  @Index()
  @Column({ type: 'timestamptz', nullable: false })
  lastSeenAt: Date;
}
