import { Injectable } from '@nestjs/common';
import { Offer, ScrapedOffer } from '@fittkereso-backend/database';

// Matches a scraped offer against a preloaded batch of this model's existing
// offers from the same source (see OfferRepository.findAllByModelAndSource),
// so ProductScrapeUpdaterService.createOrUpdateOffers can update the right
// row in place instead of blindly inserting on every scrape.
@Injectable()
export class OfferMatchingService {
  findMatch(
    preloaded: Offer[],
    scraped: ScrapedOffer,
    sellerId: string,
  ): Offer | undefined {
    const candidates = preloaded.filter((o) => o.seller.id === sellerId);

    if (scraped.externalId) {
      const byExternalId = candidates.find(
        (o) => o.externalId === scraped.externalId,
      );
      if (byExternalId) return byExternalId;
    }

    // url is not a disambiguator on its own — multiple offers (distinct
    // variants, distinct sellers on an aggregator page) can legitimately
    // share the same url. Only fall back below when there's no externalId to
    // match on at all.
    if (!scraped.externalId) {
      const fingerprint = JSON.stringify(scraped.specs ?? {});
      const bySpecs = candidates.find(
        (o) => !o.externalId && JSON.stringify(o.specs ?? {}) === fingerprint,
      );
      if (bySpecs) return bySpecs;

      if (candidates.length === 1 && !candidates[0].externalId) {
        return candidates[0];
      }
    }

    return undefined;
  }
}
