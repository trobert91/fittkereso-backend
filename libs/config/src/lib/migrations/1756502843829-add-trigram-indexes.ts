import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTrigramIndexes1735550000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE INDEX product_category_name_trgm_idx
      ON product_category USING gin (name gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX product_display_name_trgm_idx
      ON product_model USING gin ("displayName" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX product_normalized_name_trgm_idx
      ON product_model USING gin ("normalizedName" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX product_model_name_trgm_idx
      ON product_model USING gin ("model" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX product_alias_alias_trgm_idx
      ON product_alias USING gin (alias gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS product_category_name_trgm_idx`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS product_display_name_trgm_idx`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS product_model_name_trgm_idx`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS product_normalized_name_trgm_idx`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS product_alias_alias_trgm_idx`,
    );
  }
}
