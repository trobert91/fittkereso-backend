-- ============================================================================
-- Export Dynamic Config and Product Category Data
-- ============================================================================
-- This script generates INSERT statements for dynamic_config and product_category
-- tables that can be used to seed databases or migrate data.
--
-- Usage:
--   psql -d fittkereso -f export-config-data.sql > exported-data.sql
--
-- The output can then be imported into another database:
--   psql -d target_database -f exported-data.sql
-- ============================================================================

\echo '-- ============================================================================'
\echo '-- Dynamic Config Export'
\echo '-- ============================================================================'
\echo ''

-- Export dynamic_config table
SELECT
  format(
    E'INSERT INTO dynamic_config (id, created_at, updated_at, deleted_at, data) VALUES\n(%L, %L, %L, %L, %L::jsonb);',
    id,
    created_at,
    updated_at,
    deleted_at,
    data::text
  )
FROM dynamic_config
WHERE deleted_at IS NULL
ORDER BY created_at;

\echo ''
\echo '-- ============================================================================'
\echo '-- Product Category Export'
\echo '-- ============================================================================'
\echo ''

-- Export product_category table (parent categories first, then children)
-- This ensures proper foreign key relationships during import
WITH RECURSIVE category_tree AS (
  -- Base case: root categories (no parent)
  SELECT
    pc.*,
    0 AS depth,
    ARRAY[pc.id] AS path
  FROM product_category pc
  WHERE pc.parent_id IS NULL AND pc.deleted_at IS NULL

  UNION ALL

  -- Recursive case: child categories
  SELECT
    pc.*,
    ct.depth + 1,
    ct.path || pc.id
  FROM product_category pc
  INNER JOIN category_tree ct ON pc.parent_id = ct.id
  WHERE pc.deleted_at IS NULL
)
SELECT
  format(
    E'INSERT INTO product_category (id, created_at, updated_at, deleted_at, parent_id, name, enabled, json_schema, ui_schema, config, aliases, embedding_id) VALUES\n(%L, %L, %L, %L, %L, %L, %L, %s, %s, %s, %s, %L)\nON CONFLICT (id) DO UPDATE SET\n  parent_id = EXCLUDED.parent_id,\n  name = EXCLUDED.name,\n  enabled = EXCLUDED.enabled,\n  json_schema = EXCLUDED.json_schema,\n  ui_schema = EXCLUDED.ui_schema,\n  config = EXCLUDED.config,\n  aliases = EXCLUDED.aliases,\n  embedding_id = EXCLUDED.embedding_id,\n  updated_at = EXCLUDED.updated_at;',
    ct.id,
    ct.created_at,
    ct.updated_at,
    ct.deleted_at,
    ct.parent_id,
    ct.name,
    ct.enabled,
    COALESCE(quote_literal(ct.json_schema::text) || '::jsonb', 'NULL'),
    COALESCE(quote_literal(ct.ui_schema::text) || '::jsonb', 'NULL'),
    COALESCE(quote_literal(ct.config::text) || '::jsonb', 'NULL'),
    COALESCE(quote_literal(ct.aliases::text) || '::jsonb', 'NULL'),
    ct.embedding_id
  )
FROM category_tree ct
ORDER BY ct.depth, ct.name;

\echo ''
\echo '-- ============================================================================'
\echo '-- Export Complete'
\echo '-- ============================================================================'
\echo ''
\echo '-- To import this data:'
\echo '-- 1. Ensure target database has proper schema (run migrations first)'
\echo '-- 2. Run: psql -d target_database -f exported-data.sql'
\echo '-- 3. Verify import with: SELECT COUNT(*) FROM dynamic_config; SELECT COUNT(*) FROM product_category;'
