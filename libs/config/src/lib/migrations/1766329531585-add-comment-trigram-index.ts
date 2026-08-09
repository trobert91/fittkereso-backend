import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migration1766329531585 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE INDEX user_comment_body_trgm_idx
      ON user_comment USING gin ((LOWER(body)) gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX user_comment_url_trgm_idx
      ON user_comment USING gin ((LOWER(COALESCE(url, ''))) gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS user_comment_url_trgm_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS user_comment_body_trgm_idx`);
  }
}
