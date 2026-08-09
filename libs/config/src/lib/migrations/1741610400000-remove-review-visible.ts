import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1741610400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the index on visible
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_review_visible"`,
    );

    // Drop the visible column
    await queryRunner.query(
      `ALTER TABLE "review" DROP COLUMN IF EXISTS "visible"`,
    );

    // Add index on reviewScore for threshold-based filtering
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_review_reviewScore" ON "review" ("reviewScore")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the reviewScore index
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_review_reviewScore"`,
    );

    // Restore the visible column with default true
    await queryRunner.query(
      `ALTER TABLE "review" ADD "visible" boolean NOT NULL DEFAULT true`,
    );

    // Restore the index on visible
    await queryRunner.query(
      `CREATE INDEX "IDX_review_visible" ON "review" ("visible")`,
    );
  }
}
