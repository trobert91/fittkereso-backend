import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keyword-research refactor schema changes:
 *  - Add `Thread.keywords text[]` with a GIN index (records which keyword(s)
 *    discovered each thread; appended on rediscovery).
 *  - Strip EMA / source / enabled / scope bookkeeping from ThreadSearchKeyword.
 *    The table now serves a single purpose: keyword-level cooldown. Scope
 *    (subreddit) is intentionally dropped — the planner generates keywords
 *    that fan out across subreddits, but cooldown is keyword-level by design.
 *  - Rebuild the unique constraint without `scope`.
 *  - Rename `lastExecutedAt` → `lastSearchedAt` to match the new role.
 *
 * `CONCURRENTLY` on the GIN index must run outside a transaction, so this
 * migration declares `transaction = false`.
 */
export class Migration1780100000000 implements MigrationInterface {
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "thread"
      ADD COLUMN "keywords" text[] NOT NULL DEFAULT '{}'
    `);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "thread_keywords_gin_idx"
      ON "thread" USING GIN ("keywords")
    `);

    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "totalExecutions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "totalDiscovered"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "totalDuplicates"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "totalRejected"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "averageRelevance"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "yieldRate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "enabled"`,
    );

    // Drop the old unique constraint that includes `scope`. The constraint
    // name is TypeORM-generated, so look it up dynamically.
    await queryRunner.query(`
      DO $$
      DECLARE
        constraint_name TEXT;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'thread_search_keyword'::regclass
            AND contype = 'u'
        LOOP
          EXECUTE 'ALTER TABLE "thread_search_keyword" DROP CONSTRAINT "' || constraint_name || '"';
        END LOOP;
      END $$;
    `);

    // De-duplicate any rows that share (keyword, platform, categoryId) before
    // collapsing the scope dimension — keep the most-recently-searched row.
    await queryRunner.query(`
      DELETE FROM "thread_search_keyword" a
      USING "thread_search_keyword" b
      WHERE a."keyword" = b."keyword"
        AND a."platform" = b."platform"
        AND a."categoryId" = b."categoryId"
        AND COALESCE(a."lastExecutedAt", a."createdAt") < COALESCE(b."lastExecutedAt", b."createdAt")
    `);

    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" DROP COLUMN IF EXISTS "scope"`,
    );

    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      RENAME COLUMN "lastExecutedAt" TO "lastSearchedAt"
    `);

    // After the rename, ensure NOT NULL — this is now the table's only
    // non-key column and every row should have a search timestamp.
    await queryRunner.query(`
      UPDATE "thread_search_keyword"
      SET "lastSearchedAt" = now()
      WHERE "lastSearchedAt" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      ALTER COLUMN "lastSearchedAt" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      ADD CONSTRAINT "UQ_thread_search_keyword_keyword_platform_category"
      UNIQUE ("keyword", "platform", "categoryId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      DROP CONSTRAINT IF EXISTS "UQ_thread_search_keyword_keyword_platform_category"
    `);
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "scope" varchar`,
    );
    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      ALTER COLUMN "lastSearchedAt" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "thread_search_keyword"
      RENAME COLUMN "lastSearchedAt" TO "lastExecutedAt"
    `);
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "yieldRate" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "averageRelevance" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "totalRejected" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "totalDuplicates" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "totalDiscovered" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "totalExecutions" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_search_keyword" ADD COLUMN "source" varchar(32) NOT NULL DEFAULT 'static'`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "thread_keywords_gin_idx"`,
    );
    await queryRunner.query(`ALTER TABLE "thread" DROP COLUMN "keywords"`);
  }
}
