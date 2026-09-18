import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every already-configured product source a version 1, so the history
 * starts from what is actually in force rather than from the next edit.
 *
 * Without this, a source configured months ago would show an empty history
 * until somebody changed it, and that first change would appear as v1 —
 * implying the config it replaced never existed.
 *
 * Data only. The two tables themselves are created by TypeORM, which this
 * deployment drives through `synchronize` (see PostgresConfigService), so the
 * migration deliberately does not CREATE TABLE and would conflict with the
 * schema sync if it did. It is written to be safe either way: every statement
 * is guarded, and re-running it inserts nothing.
 */
export class ProductSourceVersionBackfill1790000000000 implements MigrationInterface {
  name = 'ProductSourceVersionBackfill1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tablesExist = await queryRunner.query(`
      SELECT to_regclass('public.product_source_version') AS version_table,
             to_regclass('public.product_source_action') AS action_table
    `);

    if (!tablesExist?.[0]?.version_table || !tablesExist?.[0]?.action_table) {
      // Schema sync has not created them yet; the next boot will, and this
      // backfill can be re-run then. Skipped rather than failed so a migration
      // run does not block a deploy over ordering.
      return;
    }

    // Only sources that actually hold a config. One created but never
    // configured carries '{}' — it has no revision to record, and inventing a
    // v1 of an empty config would put a version in the history that nobody
    // wrote and that could later be "restored".
    await queryRunner.query(`
      INSERT INTO product_source_version
        (id, "createdAt", "updatedAt", "sourceId", version, config, note,
         "restoredFromVersion", "actorType", "actorUserId", "actorLabel")
      SELECT
        gen_random_uuid(),
        source."createdAt",
        NOW(),
        source.id,
        1,
        source.config,
        'Backfilled from the config in force when versioning was introduced',
        NULL,
        'system',
        NULL,
        'backfill'
      FROM product_source source
      WHERE source.config IS NOT NULL
        AND source.config <> '{}'::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM product_source_version existing
          WHERE existing."sourceId" = source.id
        )
    `);

    // The matching timeline entry, so the history explains where v1 came from
    // rather than showing a version with nothing that accounts for it.
    //
    // occurredAt is the source's own createdAt, not now: the config has been
    // in force since then, and stamping it with the migration's clock would
    // put every source's first entry at the same instant, years late.
    await queryRunner.query(`
      INSERT INTO product_source_action
        (id, "createdAt", "updatedAt", "sourceId", type, payload,
         "actorType", "actorUserId", "actorLabel", "occurredAt")
      SELECT
        gen_random_uuid(),
        NOW(),
        NOW(),
        version."sourceId",
        'config_version_created',
        jsonb_build_object('version', 1, 'note', version.note, 'backfilled', true),
        'system',
        NULL,
        'backfill',
        version."createdAt"
      FROM product_source_version version
      WHERE version.version = 1
        AND version."actorLabel" = 'backfill'
        AND NOT EXISTS (
          SELECT 1 FROM product_source_action existing
          WHERE existing."sourceId" = version."sourceId"
            AND existing.type = 'config_version_created'
        )
    `);
  }

  /**
   * Removes only what this migration wrote.
   *
   * Keyed on the 'backfill' actor label rather than truncating: by the time
   * anybody reverts, real versions written by real people may sit alongside
   * these, and losing those would be losing the history this feature exists
   * to keep.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const tablesExist = await queryRunner.query(`
      SELECT to_regclass('public.product_source_version') AS version_table,
             to_regclass('public.product_source_action') AS action_table
    `);

    if (tablesExist?.[0]?.action_table) {
      await queryRunner.query(`
        DELETE FROM product_source_action
        WHERE "actorLabel" = 'backfill' AND type = 'config_version_created'
      `);
    }

    if (tablesExist?.[0]?.version_table) {
      await queryRunner.query(`
        DELETE FROM product_source_version
        WHERE "actorLabel" = 'backfill' AND version = 1
      `);
    }
  }
}
