import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';
import { StaleOfferSweepService } from '@fittkereso-backend/product';

@Injectable()
export class OfferSweepTools {
  constructor(
    private readonly sweepService: StaleOfferSweepService,
    private readonly offerFreshness: OfferFreshnessService,
  ) {}

  @Tool({
    name: 'run_stale_offer_sweep',
    description:
      'Run the nightly stale-offer sweep now (the product-collector runs it at 06:30 Budapest). It composes again the offers a seller\'s source stopped listing, reprices every product whose stored price is not its cheapest fresh offer\'s (offers.freshnessDays), and deletes offers unconfirmed for offers.deleteAfterDays — only of sellers something still confirms, and only while offers.deletionEnabled is on. Safe next to the scheduled run: each product is written under its lock.',
    parameters: z.object({}),
    annotations: { destructiveHint: true, idempotentHint: true },
  })
  async runStaleOfferSweep(): Promise<string> {
    const result = await this.sweepService.sweep();

    return [
      '## Stale offer sweep',
      '',
      `- **Settings**: freshnessDays=${this.offerFreshness.freshnessDays} · deleteAfterDays=${this.offerFreshness.deleteAfterDays} · deletionEnabled=${this.offerFreshness.deletionEnabled}`,
      `- **Products whose offers were composed again**: ${result.contributorsRecomposed}`,
      `- **Products repriced**: ${result.productsRepriced}`,
      `- **Offers deleted**: ${result.deleted} (delete cutoff ${result.cutoff.toISOString()}${result.capped ? ', capped — more remain' : ''})`,
      `- **Products recomputed after deletion**: ${result.modelsRecomputed}`,
      `- **Stale offers kept for sellers nothing confirms**: ${result.keptForSilentSellers}`,
    ].join('\n');
  }
}
