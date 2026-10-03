import { OfferCondition } from '@fittkereso-backend/database';
import { currentOfferInConditionsSql, parseConditionFilter } from './offer-condition-filter';

describe('parseConditionFilter', () => {
  it('reads a comma-separated list, case and spaces ignored', () => {
    expect(parseConditionFilter('used, Refurbished')).toEqual([
      OfferCondition.used,
      OfferCondition.refurbished,
    ]);
  });

  it('is no filter when absent or blank', () => {
    expect(parseConditionFilter(undefined)).toBeUndefined();
    expect(parseConditionFilter(' ')).toBeUndefined();
  });

  // The Postgres enum would reject an unknown value outright.
  it('drops unknown values, leaving an empty list that matches nothing', () => {
    expect(parseConditionFilter('used,mint')).toEqual([OfferCondition.used]);
    expect(parseConditionFilter('mint')).toEqual([]);
  });
});

describe('currentOfferInConditionsSql', () => {
  const cutoff = new Date('2026-09-28T00:00:00Z');

  it('numbers its parameters from where the caller left off', () => {
    expect(
      currentOfferInConditionsSql({
        conditions: [OfferCondition.used, OfferCondition.refurbished],
        cutoff,
        startParam: 4,
      }),
    ).toEqual({
      sql: 'EXISTS (SELECT 1 FROM offer o WHERE o."modelId" = product.id AND o."lastSynced" >= $4 AND o.condition IN ($5, $6))',
      params: [cutoff, OfferCondition.used, OfferCondition.refurbished],
    });
  });

  it('matches nothing for an empty list, taking no parameters', () => {
    expect(currentOfferInConditionsSql({ conditions: [], cutoff, startParam: 2 })).toEqual({
      sql: 'FALSE',
      params: [],
    });
  });
});
