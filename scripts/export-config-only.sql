-- ============================================================================
-- Export Product Category Config JSONB Only
-- ============================================================================
-- This script exports only the config JSONB field from product_category
-- in a readable format for manual review and editing.
--
-- Usage:
--   psql -d fittkereso -f export-config-only.sql
-- ============================================================================

\echo '-- ============================================================================'
\echo '-- Product Category Configurations'
\echo '-- ============================================================================'
\echo ''

SELECT
  format(
    E'-- Category: %s (ID: %s)\n-- Parent: %s\n-- Updated: %s\n',
    name,
    id,
    COALESCE(parent_id::text, 'None (root category)'),
    updated_at::date
  ) ||
  format(
    E'UPDATE product_category\nSET config = %L::jsonb\nWHERE id = %L;\n',
    jsonb_pretty(config),
    id
  ) AS update_statement
FROM product_category
WHERE deleted_at IS NULL
  AND config IS NOT NULL
ORDER BY
  CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, -- Parents first
  name;

\echo ''
\echo '-- ============================================================================'
\echo '-- Dynamic Config Data'
\echo '-- ============================================================================'
\echo ''

SELECT
  format(
    E'-- Dynamic Config (ID: %s)\n-- Updated: %s\n',
    id,
    updated_at::date
  ) ||
  format(
    E'UPDATE dynamic_config\nSET data = %L::jsonb\nWHERE id = %L;\n',
    jsonb_pretty(data),
    id
  ) AS update_statement
FROM dynamic_config
WHERE deleted_at IS NULL
ORDER BY updated_at DESC
LIMIT 1;

\echo ''
\echo '-- ============================================================================'
\echo '-- Summary'
\echo '-- ============================================================================'
\echo ''

\echo '-- Category configs with promptConfig:'
SELECT
  format('--   %s (ancestorDepth: %s, abbreviations: %s)',
    name,
    COALESCE((config->>'ancestorDepth')::text, 'not set'),
    COALESCE(jsonb_object_keys(config->'promptConfig'->'abbreviations')::text, 'none')
  )
FROM product_category
WHERE deleted_at IS NULL
  AND config->'promptConfig' IS NOT NULL
ORDER BY name;
