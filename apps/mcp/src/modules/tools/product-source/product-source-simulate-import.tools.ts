import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ProductSourceRepository } from '@fittkereso-backend/database';
import {
  ProductSourceImportSimulationResult,
  ProductSourceImportSimulationService,
} from '@fittkereso-backend/product-scraper';
import { formatListingIdentifiers } from './identifier-format';

@Injectable()
export class ProductSourceSimulateImportTools {
  constructor(
    private readonly simulation: ProductSourceImportSimulationService,
    private readonly productSourceRepo: ProductSourceRepository,
  ) {}

  @Tool({
    name: 'simulate_product_source_import',
    description:
      'Dry-run a whole IMPORT RUN for a ProductSource — what tonight would actually do — WITHOUT persisting anything (no ProductImportTasks queued, no ProductModel/Offer/ProductSourceRecord rows). Use simulate_product_source_scrape instead for one detail page. For a feed source ("arukereso" or "googleshop"): fetches the feed, reports how many of its items survive the category gate and why the rest do not, checks that the chosen externalId is actually unique across the whole feed (a repeated one silently collapses offers onto a single row), maps every eligible item and reports what a run would do with it right now — queue a feed_entry task (new, changed, or missing its offer) or only refresh the offer in place — and runs the identity extraction on the first few. For a "scraping" source: resolves the start URLs into category URLs and enumerates every page the run would enqueue, then parses one list page and reports, per card, whether it would be refreshed in place or cost a paid detail fetch — which is what makes the global minimum set tunable against a real shop. Run this before enabling scheduling on a new source.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID to simulate a run for'),
      listUrl: z
        .string()
        .url()
        .optional()
        .describe(
          'Scraping sources only: which list page to parse. Defaults to the first page the run would enqueue — pass one explicitly to check a typical listing rather than the first.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          'How many items to preview in full. Default 5. For a feed this is the only part that spends LLM calls; the whole-feed counts are free either way.',
        ),
      categorySlugs: z
        .array(z.string())
        .optional()
        .describe('Narrow the run to these category slugs, as a manual trigger would.'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  })
  async simulateProductSourceImport(args: {
    productSourceId: string;
    listUrl?: string;
    limit?: number;
    categorySlugs?: string[];
  }): Promise<string> {
    const source = await this.productSourceRepo.findOne({
      where: { id: args.productSourceId },
      relations: ['seller'],
    });
    if (!source) {
      return `No ProductSource found with id ${args.productSourceId}.`;
    }

    try {
      const result = await this.simulation.simulate(source, {
        listUrl: args.listUrl,
        limit: args.limit,
        categorySlugs: args.categorySlugs,
      });
      return this.format(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Import simulation failed: ${message}`;
    }
  }

  private format(result: ProductSourceImportSimulationResult): string {
    const L: string[] = [];
    L.push(`# Import Simulation: ${result.sourceName} (type "${result.type}")`);
    L.push('_Nothing was queued, fetched into the database, or written._');
    L.push('');

    if (result.errors.length) {
      L.push('## Errors (this run would not work as configured)');
      for (const error of result.errors) L.push(`- ${error}`);
      L.push('');
    }
    if (result.warnings.length) {
      L.push('## Warnings');
      for (const warning of result.warnings) L.push(`- ${warning}`);
      L.push('');
    }

    if (result.feed) this.formatFeed(result.feed, L);
    if (result.scraping) this.formatScraping(result.scraping, L);

    return L.join('\n');
  }

  private formatFeed(
    feed: NonNullable<ProductSourceImportSimulationResult['feed']>,
    L: string[],
  ): void {
    L.push('## Feed');
    L.push(`- **url**: ${feed.feedUrl}`);
    L.push(`- **format**: ${feed.format}`);
    L.push(`- **items parsed**: ${feed.itemsParsed}`);
    L.push(
      `- **attribute pairs dropped**: ${feed.attributesSkipped} (each was missing a name or a value)`,
    );
    L.push('');

    L.push('## What would be imported');
    L.push(`- **would import**: ${feed.wouldImport}`);
    L.push(
      `  - right now: would queue ${feed.wouldQueue} feed_entry tasks (new, changed, or missing their offer) · would refresh ${feed.wouldRefresh} offers in place`,
    );
    if (feed.matchingOffers !== undefined) {
      L.push(
        `  - this source does not identify products: ${feed.matchingOffers} of ${feed.wouldImport} rows match an existing offer of the seller and would join it; the rest would wait unattached`,
      );
    }
    L.push(`  - ${feed.rowsWithOldPrice} rows carry an old price above their price`);
    if (feed.duplicateUrls > 0) {
      L.push(`  - ${feed.duplicateUrls} rows share a URL with an earlier row; only the last of each is imported`);
    }
    L.push(`- **would skip**: ${feed.wouldSkip}`);
    for (const [reason, count] of Object.entries(feed.skipReasons).sort(
      (a, b) => (b[1] as number) - (a[1] as number),
    )) {
      L.push(`  - ${reason}: ${count}`);
    }
    L.push('');

    L.push('## Identity');
    L.push(`- **distinct externalIds**: ${feed.distinctExternalIds}`);
    L.push(
      `- **items with no externalId**: ${feed.itemsWithoutExternalId} (would fall back to the URL slug)`,
    );
    L.push(`- **DUPLICATED externalIds**: ${feed.duplicateExternalIds.length}`);
    for (const duplicate of feed.duplicateExternalIds) {
      L.push(`  - \`${duplicate.externalId}\` x${duplicate.count}`);
    }
    L.push('');

    this.formatFeedIdentifiers(feed, L);

    if (feed.productIdentifiers.length) {
      L.push('## Previewed items: what identity resolution would look up');
      feed.productIdentifiers.forEach((identifiers, index) => {
        L.push(`- ${feed.products[index]?.originalName ?? `item ${index + 1}`}`);
        L.push(...formatListingIdentifiers(identifiers, '  '));
      });
      L.push('');
    }

    L.push(`## Mapped previews (${feed.products.length})`);
    L.push('```json');
    L.push(JSON.stringify(feed.products, null, 2));
    L.push('```');
  }

  private formatFeedIdentifiers(
    feed: NonNullable<ProductSourceImportSimulationResult['feed']>,
    L: string[],
  ): void {
    const { gtin, mpn, specRows } = feed.identifiers;
    const share = (count: number) =>
      specRows.listings
        ? ` (${Math.round((count / specRows.listings) * 100)}%)`
        : '';

    L.push('## Identifiers, across every eligible item');
    if (feed.identifiers.gtinMapped) {
      L.push(
        `- **GTIN**: valid ${gtin.valid}${share(gtin.valid)} · invalid ${gtin.invalid}${share(gtin.invalid)} · none ${gtin.absent}${share(gtin.absent)}`,
      );
      const byBrand = Object.entries(feed.identifiers.invalidGtinByBrand).sort(
        (a, b) => b[1] - a[1],
      );
      if (byBrand.length) {
        const brands = byBrand.map(([brand, count]) => `${brand} ${count}`);
        const samples = feed.identifiers.invalidGtinSamples.map((v) => '`' + v + '`');
        L.push(`  - invalid by brand: ${brands.join(', ')}`);
        L.push(`  - samples: ${samples.join(', ')}`);
      }
    } else {
      L.push('- **GTIN**: _not mapped_');
    }
    L.push(
      feed.identifiers.mpnMapped
        ? `- **MPN**: stored ${mpn.valid}${share(mpn.valid)} · too short ${mpn.invalid} · none ${mpn.absent}`
        : '- **MPN**: _not mapped_',
    );
    L.push('');

    L.push('## Spec rows sent to the identity extraction');
    if (feed.matchingOffers !== undefined) {
      L.push('_This source does not identify products: no identity extraction runs._');
    } else if (!specRows.configured) {
      L.push(
        `_identityExtraction.specRows is not set — every listing sends its whole table (${specRows.meanRowsTotal} rows on average)._`,
      );
    } else {
      L.push(
        `- **rows sent per listing**: ${specRows.meanRowsSent} of ${specRows.meanRowsTotal} on average`,
      );
      L.push(
        `- **listings sending no row at all**: ${specRows.listingsWithNoRowSent}${share(specRows.listingsWithNoRowSent)}`,
      );
      L.push(
        '- **listings each label matched** (0 = a typo, or a row the shop no longer publishes):',
      );
      for (const { label, listings } of specRows.byLabel) {
        L.push(`  - ${label}: ${listings}${share(listings)}`);
      }
    }
    L.push('');
  }

  private formatScraping(
    scraping: NonNullable<ProductSourceImportSimulationResult['scraping']>,
    L: string[],
  ): void {
    L.push('## The page walk');
    L.push(`- **startUrls**: ${scraping.startUrls.length}`);
    L.push(`- **category URLs resolved**: ${scraping.categoryUrls.length}`);
    L.push(
      `- **list pages that would be enqueued**: ${scraping.pageUrls.length}`,
    );
    for (const url of scraping.pageUrls.slice(0, 10)) L.push(`  - ${url}`);
    if (scraping.pageUrls.length > 10) {
      L.push(`  - …and ${scraping.pageUrls.length - 10} more`);
    }
    L.push('');

    L.push(`## List page parsed: ${scraping.listPageParsed}`);
    if (scraping.categoryName) {
      L.push(`- **categoryName**: ${scraping.categoryName}`);
    }
    L.push(`- **minimum set**: ${scraping.requiredFields.join(', ')}`);
    L.push(
      `- **would refresh in place**: ${scraping.wouldRefreshInline} (no detail fetch spent)`,
    );
    L.push(`- **would cost a detail fetch**: ${scraping.wouldScrapeDetail}`);
    const outcomes = Object.entries(scraping.outcomes)
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(' · ');
    if (outcomes) L.push(`- **by outcome**: ${outcomes}`);
    L.push('');

    L.push('## Per-card decisions');
    for (const decision of scraping.decisions) {
      L.push(
        `- ${decision.wouldScrapeDetail ? `DETAIL FETCH (${decision.outcome})` : 'refresh'} — ${decision.url}`,
      );
      L.push(`  - ${decision.reason}`);
      L.push(
        `  - known=${decision.known} price=${decision.price ?? '_none_'} availability=${decision.availability ?? '_none_'} externalId=${decision.externalId ?? '_none_'}`,
      );
    }
  }
}
