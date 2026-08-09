/**
 * Generate a deterministic, URL-safe slug from one or two name parts.
 * Pass a single name for brands/categories.
 * Pass brandName + model for ProductModel (e.g. "Dell" + "U2723D" → "dell-u2723d").
 * Fallback: if name2 is absent or empty, uses name1 alone.
 * Collision handling: callers check DB uniqueness;
 * if taken, append '-' + id.slice(-6).
 */
export function generateSlug(
  id: string,
  name: string,
  name2?: string,
): string {
  const combined = name2?.trim() ? `${name} ${name2}` : name;
  const base = combined
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || id.slice(-6);
}
