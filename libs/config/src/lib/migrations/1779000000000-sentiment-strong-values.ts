import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the `strongPositive` and `strongNegative` values to the Postgres
 * sentiment enum types used by review.sentiment and
 * product_reference.sentiment.
 *
 * TypeORM's `synchronize: true` reliably handles enum value additions in
 * recent versions, but we run this as an explicit migration so deploys
 * cannot race with new code that emits the strong values before the type
 * has them.
 */
export class Migration1779000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "review_sentiment_enum" ADD VALUE IF NOT EXISTS 'strongPositive'`,
    );
    await queryRunner.query(
      `ALTER TYPE "review_sentiment_enum" ADD VALUE IF NOT EXISTS 'strongNegative'`,
    );
    await queryRunner.query(
      `ALTER TYPE "product_reference_sentiment_enum" ADD VALUE IF NOT EXISTS 'strongPositive'`,
    );
    await queryRunner.query(
      `ALTER TYPE "product_reference_sentiment_enum" ADD VALUE IF NOT EXISTS 'strongNegative'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres does not support removing enum values without recreating
    // the type. Existing data may already use the new values, so there
    // is no safe automated rollback.
  }
}
