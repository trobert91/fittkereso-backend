import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The public site's search document: product_model."searchName" and
 * "searchVector", their functions, the triggers that keep them current, and
 * their GIN indexes.
 *
 * The database owns the document rather than a service. ProductModel is saved
 * from many places (mergeSources and its callers, the admin's updateProduct,
 * the category re-sort, merges and splits), and a brand rename changes every
 * product's name, so a trigger is the one place that sees every write.
 * Normalisation is one SQL function, search_normalize(), which the site's
 * queries call too, so the document and the query can't drift apart.
 *
 * - search_normalize: unaccent (Hungarian buyers type without accents), lower
 *   case, and a space between digits and letters, so `600wh` and `600 Wh`
 *   both read `600 wh`.
 * - search_prefix_query: a query as a tsquery where every word is a prefix,
 *   split by the same parser as the documents. Hungarian adds suffixes, so
 *   `akkumulator:*` finds `akkumulatorral` without a stemmer, and no user
 *   input ever reaches to_tsquery's syntax.
 * - product_search_vector: weights A brand + model, C spec values (a `true`
 *   boolean contributes its label, a `false` one nothing), D description, all
 *   with the `simple` config (no stemming).
 *
 * The columns themselves are on the ProductModel entity (insert/update/select
 * false), so `synchronize` creates them; they are also added here, idempotently,
 * so the order of sync and migrations doesn't matter. Re-running is safe.
 *
 * fittkereso-frontend's test database applies a copy of PRODUCT_SEARCH_SQL
 * (scripts/sql/search.sql there), and its contract test compares the functions
 * with this database's: change one, change the other.
 */
export const PRODUCT_SEARCH_SQL = String.raw`
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.search_normalize(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(
           regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, input)),
                          '([0-9])([a-z])', '\1 \2', 'g'),
           '([a-z])([0-9])', '\1 \2', 'g')
$$;

CREATE OR REPLACE FUNCTION public.search_prefix_query(input text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT to_tsquery('simple', coalesce(string_agg(quote_literal(lexeme) || ':*', ' & '), ''))
  FROM unnest(to_tsvector('simple', public.search_normalize(input)))
$$;

CREATE OR REPLACE FUNCTION public.product_search_vector(brand text, model text, specs jsonb, description text)
RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT setweight(to_tsvector('simple', public.search_normalize(concat_ws(' ', brand, model))), 'A')
      || setweight(to_tsvector('simple', public.search_normalize(coalesce((
           SELECT string_agg(CASE s ->> 'value' WHEN 'true' THEN s ->> 'label' WHEN 'false' THEN NULL
                                                ELSE s ->> 'value' END, ' ')
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(specs) = 'array' THEN specs ELSE '[]'::jsonb END) AS s
         ), ''))), 'C')
      || setweight(to_tsvector('simple', public.search_normalize(coalesce(description, ''))), 'D')
$$;

CREATE OR REPLACE FUNCTION public.product_model_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  brand_name text;
BEGIN
  SELECT name INTO brand_name FROM public.brand WHERE id = NEW."brandId";
  -- Through jsonb_populate_record, which skips keys the row doesn't have: a
  -- build without these columns that boots with sync drops them, and product
  -- writes must keep working then (search just goes stale until the backfill).
  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'searchName', public.search_normalize(concat_ws(' ', brand_name, NEW.model)),
    'searchVector', public.product_search_vector(brand_name, NEW.model, NEW."orderedSpecs", NEW.description)
  ));
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.brand_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Touching model fires product_model_search, which reads the new name.
  UPDATE public.product_model SET model = model WHERE "brandId" = NEW.id;
  RETURN NULL;
END
$$;

ALTER TABLE public.product_model
  ADD COLUMN IF NOT EXISTS "searchName" text,
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

DROP TRIGGER IF EXISTS product_model_search ON public.product_model;
CREATE TRIGGER product_model_search
  BEFORE INSERT OR UPDATE OF model, "brandId", "orderedSpecs", description ON public.product_model
  FOR EACH ROW EXECUTE FUNCTION public.product_model_search_refresh();

DROP TRIGGER IF EXISTS brand_search ON public.brand;
CREATE TRIGGER brand_search
  AFTER UPDATE OF name ON public.brand
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.brand_search_refresh();

CREATE INDEX IF NOT EXISTS product_model_search_vector_idx
  ON public.product_model USING gin ("searchVector");
CREATE INDEX IF NOT EXISTS product_model_search_name_trgm_idx
  ON public.product_model USING gin ("searchName" gin_trgm_ops);
`;

export class ProductSearch1792000000000 implements MigrationInterface {
  name = 'ProductSearch1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [tables] = await queryRunner.query(`
      SELECT to_regclass('public.product_model') AS model_table,
             to_regclass('public.brand') AS brand_table
    `);
    if (!tables?.model_table || !tables?.brand_table) {
      // Unlike a data backfill, skipping would leave search without its
      // triggers for good (a run migration never runs again), so fail loudly.
      throw new Error('ProductSearch: product_model and brand must exist (schema sync runs first)');
    }

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(PRODUCT_SEARCH_SQL);
    // Every existing product through the trigger once.
    await queryRunner.query(`UPDATE product_model SET model = model`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS brand_search ON brand;
      DROP TRIGGER IF EXISTS product_model_search ON product_model;
      DROP INDEX IF EXISTS product_model_search_name_trgm_idx;
      DROP INDEX IF EXISTS product_model_search_vector_idx;
      ALTER TABLE product_model DROP COLUMN IF EXISTS "searchName", DROP COLUMN IF EXISTS "searchVector";
      DROP FUNCTION IF EXISTS brand_search_refresh();
      DROP FUNCTION IF EXISTS product_model_search_refresh();
      DROP FUNCTION IF EXISTS product_search_vector(text, text, jsonb, text);
      DROP FUNCTION IF EXISTS search_prefix_query(text);
      DROP FUNCTION IF EXISTS search_normalize(text);
    `);
  }
}
