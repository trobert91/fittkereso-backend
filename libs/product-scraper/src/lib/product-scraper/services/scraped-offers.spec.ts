import { OfferCondition } from '@fittkereso-backend/database';
import { toScrapedOffers } from './scraped-offers';

describe('toScrapedOffers condition', () => {
  const conditionOf = (condition: string | null | undefined) =>
    toScrapedOffers([{ price: 899000, condition }])[0].condition;

  it.each([
    ['used', OfferCondition.used],
    ['Refurbished', OfferCondition.refurbished],
    ['new', OfferCondition.new],
  ])('keeps %p as %p', (value, expected) => {
    expect(conditionOf(value)).toBe(expected);
  });

  // Mapped but unusable: the source says "none", which the offer reads as new.
  it.each([null, '', 'Használt'])('reads %p as none', (value) => {
    expect(conditionOf(value)).toBeNull();
  });

  it('leaves an unmapped condition absent, for the seller\'s other sources', () => {
    expect(conditionOf(undefined)).toBeUndefined();
  });
});
