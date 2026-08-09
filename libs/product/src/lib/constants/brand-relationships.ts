/**
 * Brand relationship mappings for sub-brands and parent brands.
 * Used to prevent false-positive cross-contamination detection when quotes
 * mention related brands (e.g., "Dell Alienware" should not trigger for a Dell product).
 */
export const BRAND_RELATIONSHIPS: Map<string, Set<string>> = new Map([
  // Dell <-> Alienware
  ['dell', new Set(['alienware'])],
  ['alienware', new Set(['dell'])],

  // ASUS <-> ROG
  ['asus', new Set(['rog'])],
  ['rog', new Set(['asus'])],

  // Acer <-> Predator
  ['acer', new Set(['predator'])],
  ['predator', new Set(['acer'])],
]);

/**
 * Check if two brands are related (sub-brand or parent brand relationship).
 * @param brand1 - First brand name (lowercase)
 * @param brand2 - Second brand name (lowercase)
 * @returns true if the brands are related, false otherwise
 */
export function areBrandsRelated(brand1: string, brand2: string): boolean {
  if (brand1 === brand2) return true;

  const relatedBrands = BRAND_RELATIONSHIPS.get(brand1);
  return relatedBrands ? relatedBrands.has(brand2) : false;
}
