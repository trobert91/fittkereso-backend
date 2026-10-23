import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * product_model."publicId": a random, unused 9-digit number per product
 * (100000000-999999999), the site's URL name for it (`p<publicId>`).
 *
 * Random rather than sequential, so the numbers can't be walked through: with a
 * few thousand products among 900 million numbers, a guess finds one about
 * once in a hundred thousand tries. They come from gen_random_uuid() (a strong
 * source), not random(). The database owns them, like the search document:
 *
 * - product_model_new_public_id(): an unused number, drawn until one is free.
 * - product_model_public_id_assign (BEFORE INSERT): gives a new product its
 *   number. The entity's column is insert/update false, so TypeORM never sends
 *   one.
 * - product_model_public_id_keep (BEFORE UPDATE): refuses to change one; a
 *   number in a shared link must keep meaning the same product.
 *
 * The column is on the ProductModel entity (with its unique index and the range
 * check), so `synchronize` creates it; it is also added here, idempotently.
 * Migrations run before the sync, so on a database that had the first,
 * sequential publicId (a serial: dev on 2026-10-23), this drops the serial's
 * default and sequence and renumbers every row before the sync adds the range
 * check. Re-running is safe.
 */
export const PRODUCT_PUBLIC_ID_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.product_model_new_public_id() RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  candidate integer;
BEGIN
  LOOP
    -- 32 random bits from a v4 uuid, into the 9-digit range.
    candidate := 100000000 + (('x' || left(replace(gen_random_uuid()::text, '-', ''), 8))::bit(32)::bigint % 900000000)::integer;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.product_model WHERE "publicId" = candidate);
  END LOOP;
  RETURN candidate;
END
$$;

CREATE OR REPLACE FUNCTION public.product_model_public_id_assign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."publicId" IS NULL THEN
    NEW."publicId" := public.product_model_new_public_id();
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.product_model_public_id_keep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."publicId" IS DISTINCT FROM OLD."publicId" THEN
    RAISE EXCEPTION 'product_model."publicId" never changes (product %)', OLD.id;
  END IF;
  RETURN NEW;
END
$$;
`;

export class ProductPublicId1793000000000 implements MigrationInterface {
  name = 'ProductPublicId1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [tables] = await queryRunner.query(
      `SELECT to_regclass('public.product_model') AS model_table`,
    );
    if (!tables?.model_table) {
      // A run migration never runs again: skipping would leave products
      // without numbers for good, so fail loudly.
      throw new Error(
        'ProductPublicId: product_model must exist (schema sync runs first)',
      );
    }

    await queryRunner.query(PRODUCT_PUBLIC_ID_SQL);
    await queryRunner.query(`
      ALTER TABLE public.product_model ADD COLUMN IF NOT EXISTS "publicId" integer;
      ALTER TABLE public.product_model ALTER COLUMN "publicId" DROP DEFAULT;
      DROP SEQUENCE IF EXISTS public."product_model_publicId_seq";
      DROP TRIGGER IF EXISTS product_model_public_id_keep ON public.product_model;
    `);
    // One row at a time, so each draw sees the numbers given before it.
    await queryRunner.query(`
      DO $$
      DECLARE
        row_id uuid;
      BEGIN
        FOR row_id IN
          SELECT id FROM public.product_model
          WHERE "publicId" IS NULL OR "publicId" NOT BETWEEN 100000000 AND 999999999
        LOOP
          UPDATE public.product_model SET "publicId" = public.product_model_new_public_id() WHERE id = row_id;
        END LOOP;
      END
      $$;
    `);
    await queryRunner.query(`
      ALTER TABLE public.product_model ALTER COLUMN "publicId" SET NOT NULL;
      DROP TRIGGER IF EXISTS product_model_public_id_assign ON public.product_model;
      CREATE TRIGGER product_model_public_id_assign
        BEFORE INSERT ON public.product_model
        FOR EACH ROW EXECUTE FUNCTION public.product_model_public_id_assign();
      CREATE TRIGGER product_model_public_id_keep
        BEFORE UPDATE OF "publicId" ON public.product_model
        FOR EACH ROW EXECUTE FUNCTION public.product_model_public_id_keep();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS product_model_public_id_keep ON public.product_model;
      DROP TRIGGER IF EXISTS product_model_public_id_assign ON public.product_model;
      DROP FUNCTION IF EXISTS public.product_model_public_id_keep();
      DROP FUNCTION IF EXISTS public.product_model_public_id_assign();
      DROP FUNCTION IF EXISTS public.product_model_new_public_id();
    `);
  }
}
