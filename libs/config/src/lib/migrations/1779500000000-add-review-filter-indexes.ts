import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1779500000000 implements MigrationInterface {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  // This per-migration override tells the TypeORM runner to skip BEGIN/COMMIT.
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_review_model_active_score
      ON review ("modelId", "reviewScore" DESC)
      WHERE "enabled" = true AND "deletedAt" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_review_intents_gin
      ON review USING gin ("intents")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_review_intents_gin`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_review_model_active_score`);
  }
}
