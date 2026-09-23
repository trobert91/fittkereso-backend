import {
  ProductSourceFilterCondition,
  ProductSourceFilterConfig,
} from '@fittkereso-backend/database';

/**
 * Resolves a condition's `field` to the value to test.
 *
 * The one thing the two source types genuinely differ on: a feed item's fields
 * are a normalized-name map of arbitrary columns, a list card's are the
 * properties of a fixed interface. Passing the lookup in keeps every operator,
 * the `all`/`any` combination and the case rules in one implementation, instead
 * of two that drift.
 *
 * Return `undefined` for a field the item does not have — that is what
 * `isEmpty` tests, and what makes every other operator fail closed.
 */
export type FilterFieldResolver = (field: string) => unknown;

/**
 * Does this item belong in the run?
 *
 * No filter means yes. An empty condition list means yes — a filter that
 * excludes nothing is a configuration mistake, not a reason to import nothing,
 * and the schema already refuses it on the way in.
 */
export function matchesFilter(
  filter: ProductSourceFilterConfig | undefined,
  resolve: FilterFieldResolver,
): boolean {
  if (!filter?.conditions?.length) return true;

  const results = filter.conditions.map((condition) =>
    matchesCondition(condition, resolve(condition.field), filter.caseSensitive),
  );

  return filter.match === 'any'
    ? results.some(Boolean)
    : results.every(Boolean);
}

/**
 * One condition against one value.
 *
 * Every operator present must hold. The schema asks for one, but two is
 * coherent (`gte` with `lt` is a range) and silently honouring only the first
 * would be worse than honouring both.
 */
function matchesCondition(
  condition: ProductSourceFilterCondition,
  raw: unknown,
  caseSensitive = false,
): boolean {
  const present = raw !== undefined && raw !== null && String(raw).trim() !== '';
  const value = present ? String(raw).trim() : '';

  // Checked first and on its own: it is the only operator that is ABOUT
  // absence, so it must not be short-circuited by the present-value guard.
  if (condition.isEmpty !== undefined) {
    if (condition.isEmpty === present) return false;
  }

  const fold = (text: string) => (caseSensitive ? text : text.toLowerCase());
  const subject = fold(value);

  // An absent field fails every value test rather than passing vacuously —
  // "brand equals KTM" must not match a product with no brand.
  const requiresValue =
    condition.equals !== undefined ||
    condition.contains !== undefined ||
    condition.matches !== undefined ||
    condition.in !== undefined ||
    condition.gt !== undefined ||
    condition.gte !== undefined ||
    condition.lt !== undefined ||
    condition.lte !== undefined;
  if (!present && requiresValue) return false;

  if (condition.equals !== undefined && subject !== fold(condition.equals)) {
    return false;
  }
  if (condition.notEquals !== undefined && subject === fold(condition.notEquals)) {
    return false;
  }
  if (
    condition.contains !== undefined &&
    !subject.includes(fold(condition.contains))
  ) {
    return false;
  }
  if (
    condition.notContains !== undefined &&
    subject.includes(fold(condition.notContains))
  ) {
    return false;
  }
  if (condition.matches !== undefined) {
    // A bad pattern is a config error, and failing the item is the safe
    // reading: a filter that silently matched everything would import a whole
    // catalogue where ten products were asked for.
    let expression: RegExp;
    try {
      expression = new RegExp(condition.matches, caseSensitive ? '' : 'i');
    } catch {
      return false;
    }
    if (!expression.test(value)) return false;
  }
  if (
    condition.in !== undefined &&
    !condition.in.some((candidate) => fold(candidate) === subject)
  ) {
    return false;
  }
  if (
    condition.notIn !== undefined &&
    condition.notIn.some((candidate) => fold(candidate) === subject)
  ) {
    return false;
  }

  const numeric =
    condition.gt !== undefined ||
    condition.gte !== undefined ||
    condition.lt !== undefined ||
    condition.lte !== undefined;
  if (numeric) {
    const number = Number(value.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(number)) return false;
    if (condition.gt !== undefined && !(number > condition.gt)) return false;
    if (condition.gte !== undefined && !(number >= condition.gte)) return false;
    if (condition.lt !== undefined && !(number < condition.lt)) return false;
    if (condition.lte !== undefined && !(number <= condition.lte)) return false;
  }

  return true;
}
