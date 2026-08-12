# Database Export Scripts

This directory contains SQL scripts for exporting configuration data from the fittkereso backend database.

## Available Scripts

### 1. `export-config-data.sql` - Full Export with INSERT Statements

**Purpose:** Export complete data from `dynamic_config` and `product_category` tables as INSERT statements that can be imported into another database.

**Usage:**

```bash
# Export to file
psql -d fittkereso -f scripts/export-config-data.sql > exported-data.sql

# Import into target database
psql -d target_database -f exported-data.sql
```

**Features:**

- Generates INSERT statements with UPSERT (ON CONFLICT DO UPDATE)
- Exports categories in hierarchical order (parents before children)
- Properly escapes JSONB data
- Handles NULL values correctly
- Safe to re-run on existing database (uses UPSERT)

**Output Format:**

```sql
INSERT INTO dynamic_config (id, created_at, updated_at, deleted_at, data) VALUES
('uuid-here', '2024-01-15', '2024-01-15', NULL, '{"threadProcessingPerDay": 100}'::jsonb);

INSERT INTO product_category (id, ..., config, ...) VALUES
('monitors', ..., '{"promptConfig": {"abbreviations": {...}}}'::jsonb, ...)
ON CONFLICT (id) DO UPDATE SET ...;
```

---

### 2. `export-config-only.sql` - Config JSONB Only (Readable Format)

**Purpose:** Export only the `config` JSONB fields in a human-readable format for review and manual editing.

**Usage:**

```bash
# View in terminal (recommended)
psql -d fittkereso -f scripts/export-config-only.sql

# Export to file
psql -d fittkereso -f scripts/export-config-only.sql > config-review.sql
```

**Features:**

- Pretty-printed JSON for readability
- Generates UPDATE statements (easier to modify existing data)
- Includes metadata comments (category name, parent, last update)
- Shows summary of categories with promptConfig

**Output Format:**

```sql
-- Category: monitors (ID: uuid-here)
-- Parent: None (root category)
-- Updated: 2024-01-15

UPDATE product_category
SET config = '{
  "promptConfig": {
    "abbreviations": {
      "UW": "ultrawide",
      "IPS": "In-Plane Switching"
    },
    "acceptedSpecs": ["inch", "Hz", "ms"],
    "rejectedTerms": ["modes", "settings"]
  },
  "ancestorDepth": 3
}'::jsonb
WHERE id = 'uuid-here';
```

---

## Common Use Cases

### 1. Backup Configuration Before Changes

```bash
# Create timestamped backup
psql -d fittkereso -f scripts/export-config-data.sql > backups/config-$(date +%Y%m%d).sql
```

### 2. Review Current Configuration

```bash
# View readable config in terminal
psql -d fittkereso -f scripts/export-config-only.sql | less
```

### 3. Seed Development Database

```bash
# Export from production
psql -d fittkereso_prod -f scripts/export-config-data.sql > prod-config.sql

# Import to dev
psql -d fittkereso_dev -f prod-config.sql
```

### 4. Migrate Configuration to New Environment

```bash
# Export
psql -h prod-db.example.com -U user -d fittkereso -f scripts/export-config-data.sql > config.sql

# Import
psql -h staging-db.example.com -U user -d fittkereso -f config.sql
```

### 5. Extract Category Config for Documentation

```bash
# Export monitors config to file
psql -d fittkereso -c "
  SELECT jsonb_pretty(config)
  FROM product_category
  WHERE name = 'monitors' AND deleted_at IS NULL
" > docs/monitors-config.json
```

---

## Database Schema Reference

### `dynamic_config` Table

```sql
CREATE TABLE dynamic_config (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP,
  data JSONB DEFAULT '{}'::jsonb
);
```

**Example `data` structure:**

```json
{
  "threadProcessingPerDay": 100,
  "redditSearchThreadLimit": 50,
  "redditThreadExpiryInDays": 30,
  "enableHybridModelSelection": true,
  "plannerComplexityThreshold": 50,
  "extractorComplexityThreshold": 45,
  "processor": {
    "relevance": {
      "minApprovalScore": 50
    }
  },
  "pipeline": {
    "saveStrategy": "on-block",
    "ancestorDepth": 3
  },
  "category": {
    "tvs": {
      "ancestorDepth": 4
    }
  }
}
```

### `product_category` Table

```sql
CREATE TABLE product_category (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP,
  parent_id UUID REFERENCES product_category(id),
  name VARCHAR UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT true,
  json_schema JSONB,
  ui_schema JSONB,
  config JSONB,
  aliases JSONB,
  embedding_id UUID
);
```

**Example `config` structure:**

```json
{
  "keywordIdentifiers": ["monitor", "display", "screen"],
  "relevanceTerms": [...],
  "matchingConfig": {...},
  "normalizationConfig": {...},
  "promptConfig": {
    "examples": [
      {
        "input": "Example comment text",
        "output": "Expected extraction",
        "description": "Purpose of this example"
      }
    ],
    "acceptedSpecs": ["inch", "Hz", "ms", "nits"],
    "rejectedTerms": ["app", "streaming", "cable"],
    "abbreviations": {
      "UW": "ultrawide",
      "IPS": "In-Plane Switching",
      "VA": "Vertical Alignment"
    },
    "specialInstructions": "Focus on panel technology and refresh rate"
  },
  "ancestorDepth": 3
}
```

---

## Troubleshooting

### Issue: Permission Denied

```bash
# Ensure you have read permissions
psql -d fittkereso -c "SELECT COUNT(*) FROM dynamic_config;"
psql -d fittkereso -c "SELECT COUNT(*) FROM product_category;"
```

### Issue: JSONB Formatting Errors

If the exported JSONB doesn't import correctly:

```bash
# Validate JSON before import
psql -d fittkereso -c "SELECT jsonb_pretty(config) FROM product_category WHERE name = 'monitors';"
```

### Issue: Foreign Key Violations During Import

The `export-config-data.sql` script exports categories in hierarchical order (parents before children), but if you're importing into a database with existing data, you may need to:

```sql
-- Temporarily disable constraints
SET session_replication_role = replica;

-- Run import
\i exported-data.sql

-- Re-enable constraints
SET session_replication_role = DEFAULT;
```

---

## Related Documentation

- Configuration Layer Usage: `libs/config/src/lib/review-collector/examples/README.md`
- Phase 2 Implementation Plan: `docs/steps/2_phase2-high-impact-changes-plan.md`
- TypeORM Migrations: `libs/config/src/lib/migrations/`
- Category Config Examples: `libs/config/src/lib/review-collector/product-categories/`
- Default Config Values: `libs/config/src/lib/review-collector/defaults/`

---

## Version History

- **2024-02-13**: Initial version with full export and config-only export scripts
