import { OfferAvailability, ScrapedOffer } from '@fittkereso-backend/database';
import { RawOfferRecord } from '@fittkereso-backend/scrape-interpreter';
import { normalizeUrl } from '@fittkereso-backend/utils';

/**
 * The interpreter's offers as stored on a listing.
 *
 * RawOfferRecord's fields are all optional (interpreter output before
 * validation); ScrapedOffer requires price, so entries missing it are dropped
 * here rather than persisted as broken Offer rows.
 *
 * `null` passes through untouched: it is the source saying "none" for a field
 * it maps, which is not the same as not mapping it (see ScrapedOffer).
 *
 * Only an offer's OWN specs are set here (an assembleOffer op's per-item
 * `specs` sub-pipelines, e.g. frameSize varying per variant). Every other
 * offer gets the page's listing-level values once the identity extraction has
 * produced them — see SpecPostProcessService.
 */
export function toScrapedOffers(rawOffers: RawOfferRecord[]): ScrapedOffer[] {
  return rawOffers
    .filter(
      (offer): offer is RawOfferRecord & { price: number } =>
        typeof offer.price === 'number' && Number.isFinite(offer.price),
    )
    .map((offer) => ({
      price: offer.price,
      priceWithoutDiscount: offer.priceWithoutDiscount,
      currency: offer.currency,
      availability: parseAvailability(offer.availability),
      url: offer.url ? normalizeUrl(offer.url) : offer.url,
      externalId: offer.externalId,
      gtin: offer.gtin,
      mpn: offer.mpn,
      locations: offer.locations,
      specs: offer.specs,
    }));
}

/**
 * A value that is not one of the four states is read as "none" — the source
 * maps the field but said nothing usable.
 */
function parseAvailability(
  value: string | null | undefined,
): OfferAvailability | null | undefined {
  if (value === undefined) return undefined;
  return value && (Object.values(OfferAvailability) as string[]).includes(value)
    ? (value as OfferAvailability)
    : null;
}
