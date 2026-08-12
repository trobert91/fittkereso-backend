import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmbeddingVectorToProductModel1736720000000 implements MigrationInterface {
  name = 'AddEmbeddingVectorToProductModel1736720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure pgvector extension is enabled
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Add the embedding column (1536 dimensions for OpenAI embeddings)
    await queryRunner.query(
      `ALTER TABLE "product_embedding" ADD COLUMN "embedding" vector(1536) NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS product_embedding_idx ON "product_embedding" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS product_embedding_idx`);
    await queryRunner.query(
      `ALTER TABLE "product_embedding" DROP COLUMN "embedding"`,
    );
  }
}
