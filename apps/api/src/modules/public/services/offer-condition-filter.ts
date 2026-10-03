import { OfferCondition, parseOfferCondition } from '@fittkereso-backend/database';
import { compact, isEmpty, uniq } from 'lodash';

/** What the public site calls each condition. */
export const OFFER_CONDITION_LABELS: Record<OfferCondition, string> = {
  [OfferCondition.new]: 'Új',
  [OfferCondition.used]: 'Használt',
  [OfferCondition.refurbished]: 'Felújított',
};

/**
 * The `condition` query parameter, comma-separated like `brand`. Undefined
 * when absent or blank. Unknown values are dropped, so one naming only unknown
 * values is an empty list, which matches nothing, as an unknown brand slug does.
 */
export function parseConditionFilter(value: string | undefined): OfferCondition[] | undefined {
  if (!value?.trim()) return undefined;
  return uniq(compact(value.split(',').map(parseOfferCondition)));
}

/**
 * `EXISTS` an offer of `product` synced since `cutoff` in one of `conditions`,
 * as raw SQL with positional parameters from `startParam`. Current offers only:
 * a product whose one used offer went stale is not for sale used.
 */
export function currentOfferInConditionsSql(params: {
  conditions: OfferCondition[];
  cutoff: Date;
  startParam: number;
}): { sql: string; params: unknown[] } {
  const { conditions, cutoff, startParam } = params;
  if (isEmpty(conditions)) return { sql: 'FALSE', params: [] };

  const placeholders = conditions.map((_, index) => `$${startParam + 1 + index}`).join(', ');
  return {
    sql: `EXISTS (SELECT 1 FROM offer o WHERE o."modelId" = product.id AND o."lastSynced" >= $${startParam} AND o.condition IN (${placeholders}))`,
    params: [cutoff, ...conditions],
  };
}
