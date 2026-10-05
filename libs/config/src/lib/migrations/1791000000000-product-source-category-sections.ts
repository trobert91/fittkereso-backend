import { MigrationInterface, QueryRunner } from 'typeorm';
import { hasLegacyCategoryKeys, toCategorySections } from '@fittkereso-backend/database';

const NOTE =
  "Per-category sections: each category's rules, spec mapping and identity rows moved under categories.<slug>";
const ACTOR_LABEL = 'category-sections';

/**
 * Moves every stored config to the per-category layout: each category's
 * switch, gate rules, spec mapping and identity rows under
 * `categories.<slug>` (toCategorySections).
 *
 * A migration rather than an edit through MCP because neither schema accepts
 * the other's layout (`additionalProperties: false`): the old code refuses the
 * new keys, and the new code refuses every config that still has the old
 * ones, before a sync does any work. So the configs are converted at boot,
 * before anything reads them.
 *
 * Data only, like ProductSourceVersionBackfill1790000000000, and written the
 * same way. Each converted config is written as a new version with its
 * timeline entry, exactly as a save would, so the change is in the history
 * and the old layout stays there. Restoring a version from before it converts
 * that version on the way back. Re-running it changes nothing: a config with
 * no old key is skipped.
 */
export class ProductSourceCategorySections1791000000000 implements MigrationInterface {
  name = 'ProductSourceCategorySections1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tablesExist = await queryRunner.query(`
      SELECT to_regclass('public.product_source') AS source_table,
             to_regclass('public.product_source_version') AS version_table,
             to_regclass('public.product_source_action') AS action_table
    `);
    const tables = tablesExist?.[0];
    if (!tables?.source_table || !tables?.version_table || !tables?.action_table) {
      // Schema sync has not created them yet; there is nothing to convert.
      return;
    }

    const sources: { id: string; type: string; config: unknown }[] = await queryRunner.query(
      `SELECT id, type, config FROM product_source`,
    );

    for (const source of sources) {
      if (!hasLegacyCategoryKeys(source.config, source.type)) continue;
      const config = JSON.stringify(toCategorySections(source.config, source.type));

      const [{ next }] = await queryRunner.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM product_source_version WHERE "sourceId" = $1`,
        [source.id],
      );

      await queryRunner.query(
        `INSERT INTO product_source_version
           (id, "createdAt", "updatedAt", "sourceId", version, config, note,
            "restoredFromVersion", "actorType", "actorUserId", "actorLabel")
         VALUES (gen_random_uuid(), NOW(), NOW(), $1, $2, $3::jsonb, $4, NULL, 'system', NULL, $5)`,
        [source.id, next, config, NOTE, ACTOR_LABEL],
      );
      await queryRunner.query(
        `UPDATE product_source SET config = $2::jsonb, "updatedAt" = NOW() WHERE id = $1`,
        [source.id, config],
      );
      await queryRunner.query(
        `INSERT INTO product_source_action
           (id, "createdAt", "updatedAt", "sourceId", type, payload,
            "actorType", "actorUserId", "actorLabel", "occurredAt")
         VALUES (gen_random_uuid(), NOW(), NOW(), $1, 'config_version_created', $2::jsonb,
                 'system', NULL, $3, NOW())`,
        [source.id, JSON.stringify({ version: Number(next), note: NOTE }), ACTOR_LABEL],
      );
    }
  }

  /**
   * Nothing to undo in place: the old layout no longer validates, so putting
   * it back would stop every source. Each source's previous version still
   * holds it, for the code that reads it.
   */
  public async down(): Promise<void> {
    return;
  }
}
