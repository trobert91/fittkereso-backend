import { MigrationInterface, QueryRunner } from 'typeorm';

export class WebSearchCacheTrigram1771189377000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure pg_trgm extension exists (should already exist from earlier migrations)
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // Create trigram index on normalized keyword for similarity matching
    await queryRunner.query(`
      CREATE INDEX web_search_cache_keyword_trgm_idx
        ON web_search_cache USING gin ("normalizedKeyword" gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS web_search_cache_keyword_trgm_idx;`,
    );
  }
}
