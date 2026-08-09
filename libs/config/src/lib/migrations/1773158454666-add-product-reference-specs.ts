import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1773158454666 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_reference" ADD "specs" text[]`,
    );

    // Backfill from context JSONB for existing rows
    await queryRunner.query(`
      UPDATE "product_reference"
      SET "specs" = (
        SELECT array_agg(elem)
        FROM jsonb_array_elements_text(context->'input'->'specs') AS elem
      )
      WHERE context->'input'->'specs' IS NOT NULL
        AND jsonb_array_length(context->'input'->'specs') > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_reference" DROP COLUMN "specs"`,
    );
  }
}
