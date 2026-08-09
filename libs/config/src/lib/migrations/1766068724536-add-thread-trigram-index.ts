import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1766068724536 implements MigrationInterface {
  name = 'Migration1766068724536';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE INDEX thread_title_trgm_idx
      ON thread USING gin (title gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS thread_title_trgm_idx`);
  }
}
