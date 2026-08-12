import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the entire Reddit-thread-ingestion / comment-extraction / review
 * feature area: threads, comments, reviews, product-reference resolution
 * bookkeeping, and product ratings (computed exclusively from reviews).
 *
 * The corresponding application code (entities, repositories, services,
 * controllers) has already been removed. This migration is purely additive —
 * no earlier migration is edited. Tables are dropped in FK-safe order with
 * `CASCADE` as a safety net for any constraint ordering this list misses.
 *
 * This is a one-way retirement, not a reversible schema change — `down()`
 * intentionally does not attempt to recreate the dropped tables (there is no
 * data to restore, and reconstructing the full historical schema here would
 * only reintroduce dead structure). Restore from a pre-migration backup if
 * this ever needs to be rolled back.
 */
export class Migration1780200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "review_feedback" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "review_label" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "review" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "product_reference_candidate" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "product_reference" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_comment" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "thread_product_category" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "thread_run" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "thread_search_keyword" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "thread_search_task" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "thread" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_rating" CASCADE`);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Migration1780200000000 is not reversible — the thread/comment/review ' +
        'feature area was fully retired and its application code removed. ' +
        'Restore from a pre-migration backup if this needs to be rolled back.',
    );
  }
}
