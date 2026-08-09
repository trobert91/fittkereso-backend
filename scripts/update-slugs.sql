-- Update slugs for product_category, product_model, and brand tables.
-- Slug format: lowercase, non-alphanumeric chars replaced with hyphens,
-- leading/trailing hyphens removed, consecutive hyphens collapsed.

CREATE OR REPLACE FUNCTION slugify(input text)
RETURNS text AS $$
BEGIN
  RETURN regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(trim(input)),
        '[^a-z0-9]+', '-', 'g'  -- replace non-alphanumeric sequences with a hyphen
      ),
      '^-+|-+$', '', 'g'        -- strip leading/trailing hyphens
    ),
    '-{2,}', '-', 'g'           -- collapse consecutive hyphens (safety net)
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Product categories (keyed on "name")
UPDATE product_category
SET slug = slugify(name)
WHERE slug IS NULL OR slug = '';

-- Products (keyed on "displayName")
UPDATE product_model
SET slug = slugify("displayName")
WHERE slug IS NULL OR slug = '';

-- Brands (keyed on "name")
UPDATE brand
SET slug = slugify(name)
WHERE slug IS NULL OR slug = '';

DROP FUNCTION slugify(text);
