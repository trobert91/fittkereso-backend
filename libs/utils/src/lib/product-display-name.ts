/**
 * The name a product is shown by: its brand's name, then its model. A model
 * that already starts with the brand — a product named from a shop's title
 * when no listing named it — keeps the brand once.
 */
export function productDisplayName(brandName: string | undefined, model: string): string {
  const name = model.trim();
  const brand = brandName?.trim();
  if (!brand) return name;
  return name.toLowerCase().startsWith(`${brand.toLowerCase()} `) || name.toLowerCase() === brand.toLowerCase()
    ? name
    : `${brand} ${name}`;
}

/**
 * productDisplayName in SQL, over two column expressions — for a query that
 * searches, sorts or selects by the shown name.
 */
export function productDisplayNameSql(brandColumn: string, modelColumn: string): string {
  const name = `BTRIM(${modelColumn})`;
  const brand = `BTRIM(${brandColumn})`;
  return `CASE
    WHEN ${brand} IS NULL OR ${brand} = ''
      OR LOWER(${name}) = LOWER(${brand})
      OR LOWER(LEFT(${name}, LENGTH(${brand}) + 1)) = LOWER(${brand}) || ' '
    THEN ${name}
    ELSE ${brand} || ' ' || ${name}
  END`;
}
