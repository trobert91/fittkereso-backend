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
