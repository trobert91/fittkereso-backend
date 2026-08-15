import { Injectable } from '@nestjs/common';
import { Seller, SellerRepository, SellerType } from '@fittkereso-backend/database';
import { generateSlug } from '@fittkereso-backend/utils';

// Resolve-or-create for sellers discovered via scraping. Deliberately simple
// (exact-name lookup, no fuzzy/alias matching) — scraped seller names are
// expected to already be canonical strings from the source page, unlike
// brand names which need BrandResolutionService's heavier trigram/alias
// machinery to reconcile free-text variance.
@Injectable()
export class SellerResolutionService {
  constructor(private readonly sellerRepo: SellerRepository) {}

  public async resolveOrCreate(sellerName: string): Promise<Seller> {
    const trimmed = sellerName.trim();
    const existing = await this.sellerRepo.findOne({ where: { name: trimmed } });
    if (existing) return existing;

    const seller = new Seller();
    seller.name = trimmed;
    seller.type = SellerType.business;
    seller.verified = false;
    seller.active = true;

    try {
      const saved = await this.sellerRepo.save(seller);
      if (!saved.slug) {
        saved.slug = generateSlug(saved.id, trimmed);
        await this.sellerRepo.save(saved);
      }
      return saved;
    } catch (error) {
      if (this.isNameConflict(error)) {
        // Concurrent worker created it first — re-fetch, mirroring
        // ProductScrapeUpdaterService.saveProductModel's race-retry pattern.
        const raceWinner = await this.sellerRepo.findOne({
          where: { name: trimmed },
        });
        if (raceWinner) return raceWinner;
      }
      throw error;
    }
  }

  private isNameConflict(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes('duplicate key value') &&
      error.message.includes('name')
    );
  }
}
