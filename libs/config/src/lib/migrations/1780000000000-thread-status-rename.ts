import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename ThreadStatus values to disambiguate cheap-scorer rejections from
 * LLM rejections:
 *   - `no_categories` splits into:
 *       - `low_estimation` (cheap scorer rejected, relevance never computed)
 *       - `llm_no_category` (LLM ran but no category cleared the threshold)
 *   - `skipped` → `llm_low_relevance`
 *
 * Postgres enums can't have values renamed when the rename involves a
 * split, and `synchronize: true` will try (and fail) to reconcile orphaned
 * values, so we recreate the type with the new value set and remap rows
 * during the column type change. The cheap/LLM split for `no_categories`
 * is decided by whether `relevance` is set — only the LLM writes that
 * column.
 */
export class Migration1780000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "thread_status_enum_new" AS ENUM (
        'new',
        'reprocessing',
        'processing',
        'selected',
        'low_estimation',
        'llm_no_category',
        'llm_low_relevance',
        'extracted',
        'deleted'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "thread"
        ALTER COLUMN "status" DROP DEFAULT,
        ALTER COLUMN "status" TYPE "thread_status_enum_new" USING (
          CASE
            WHEN "status"::text = 'no_categories' AND "relevance" IS NULL
              THEN 'low_estimation'::thread_status_enum_new
            WHEN "status"::text = 'no_categories'
              THEN 'llm_no_category'::thread_status_enum_new
            WHEN "status"::text = 'skipped'
              THEN 'llm_low_relevance'::thread_status_enum_new
            ELSE "status"::text::thread_status_enum_new
          END
        ),
        ALTER COLUMN "status" SET DEFAULT 'new'
    `);

    await queryRunner.query(`DROP TYPE "thread_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "thread_status_enum_new" RENAME TO "thread_status_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "thread_status_enum_old" AS ENUM (
        'new',
        'reprocessing',
        'processing',
        'selected',
        'no_categories',
        'extracted',
        'skipped',
        'deleted'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "thread"
        ALTER COLUMN "status" DROP DEFAULT,
        ALTER COLUMN "status" TYPE "thread_status_enum_old" USING (
          CASE
            WHEN "status"::text IN ('low_estimation', 'llm_no_category')
              THEN 'no_categories'::thread_status_enum_old
            WHEN "status"::text = 'llm_low_relevance'
              THEN 'skipped'::thread_status_enum_old
            ELSE "status"::text::thread_status_enum_old
          END
        ),
        ALTER COLUMN "status" SET DEFAULT 'new'
    `);

    await queryRunner.query(`DROP TYPE "thread_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "thread_status_enum_old" RENAME TO "thread_status_enum"`,
    );
  }
}
