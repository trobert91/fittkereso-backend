import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  DEFAULT_PRODUCT_SOURCE_FETCH_MODE,
  isScrapingConfig,
  PRODUCT_SOURCE_FETCH_MODES,
  ProductSourceFetchMode,
  ProductSourceRepository,
  ScrapingSourceConfig,
} from '@fittkereso-backend/database';
import {
  ProductSourceSimulationResult,
  ProductSourceSimulationService,
} from '@fittkereso-backend/product-scraper';
import { formatListingIdentifiers } from './identifier-format';

@Injectable()
export class ProductSourceSimulateScrapeTools {
  constructor(
    private readonly simulationService: ProductSourceSimulationService,
    private readonly productSourceRepo: ProductSourceRepository,
  ) {}

  @Tool({
    name: 'simulate_product_source_scrape',
    description:
      "Dry-run a product detail page scrape against a real URL, using the generic scraper to fetch the page and the same interpreter/spec-extraction/post-process/brand-resolution pipeline the real scraper uses for detailPage — WITHOUT persisting anything (no ProductModel/Offer/ProductSourceRecord rows, no brand creation, no image copying). Returns the raw scrape-op extraction (rawSpecs, brand, model, images, offers), the resolved category, deterministic vs LLM-merged specs, brand-resolution outcome, and a preview of what the final product model would look like — plus warnings/errors explaining anything that would cause the real pipeline to skip or abort. Use this to validate/tune a ProductSourceConfig's detailPage pipeline (e.g. while drafting a new ProductSource) before saving it via update_product_source or create_product_source_for_seller.",
    parameters: z
      .object({
        url: z.string().url().describe('A real product detail page URL to scrape'),
        config: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            'Full ProductSourceConfig JSON to test (baseUrl, detailPage pipelines, categories, specMapping, etc.) — use this to test a config that is not saved yet, or a modified version of one. Exactly one of config/productSourceId must be given.',
          ),
        productSourceId: z
          .string()
          .optional()
          .describe(
            "Use an existing ProductSource's already-saved config instead of passing one inline. Exactly one of config/productSourceId must be given.",
          ),
        fetchMode: z
          .enum(PRODUCT_SOURCE_FETCH_MODES)
          .optional()
          .describe(
            "How to fetch the page: 'proxied' through Zyte (paid) or 'direct' from the shop (free, needs the shop's consent). Defaults to the source's own fetchMode with productSourceId, 'proxied' with an inline config. Pass 'direct' to check a shop before switching it to direct.",
          ),
      })
      .refine((args) => !!args.config !== !!args.productSourceId, {
        message: 'Provide exactly one of config or productSourceId',
      }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  })
  async simulateProductSourceScrape(args: {
    url: string;
    config?: Record<string, unknown>;
    productSourceId?: string;
    fetchMode?: ProductSourceFetchMode;
  }): Promise<string> {
    let config: ScrapingSourceConfig;
    let fetchMode = args.fetchMode ?? DEFAULT_PRODUCT_SOURCE_FETCH_MODE;
    if (args.productSourceId) {
      const source = await this.productSourceRepo.findOneOrFail({
        where: { id: args.productSourceId },
      });
      // This tool simulates DETAIL-PAGE scraping, which only a scraping source
      // has. An Árukereső source maps feed rows instead and has no page to run.
      if (!isScrapingConfig(source.config) || !source.config.detailPage) {
        return `Product source ${args.productSourceId} is not a scraping source with a detailPage config — nothing to simulate.`;
      }
      config = source.config;
      fetchMode = args.fetchMode ?? source.fetchMode;
    } else {
      config = args.config as unknown as ScrapingSourceConfig;
      if (!config?.detailPage) {
        return 'The given config has no detailPage pipeline — nothing to simulate.';
      }
    }

    try {
      const result = await this.simulationService.simulateDetailPageScrape(
        args.url,
        config,
        fetchMode,
      );
      return this.formatResult(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Simulation failed: ${message}`;
    }
  }

  private formatResult(result: ProductSourceSimulationResult): string {
    const L: string[] = [];
    L.push(`# Scrape Simulation: ${result.url}`);
    L.push(`- **HTML fetched**: ${result.html.length} chars (${result.fetchMode})`);
    L.push('');

    if (result.errors.length) {
      L.push('## Errors (would abort/skip product creation)');
      for (const error of result.errors) L.push(`- ${error}`);
      L.push('');
    }
    if (result.warnings.length) {
      L.push('## Warnings');
      for (const warning of result.warnings) L.push(`- ${warning}`);
      L.push('');
    }

    L.push('## Raw Extraction (detailPage pipelines)');
    L.push(`- **brand**: ${result.extraction.brand ?? '_not extracted_'}`);
    L.push(`- **model**: ${result.extraction.model ?? '_not extracted_'}`);
    L.push(`- **aliases**: ${result.extraction.aliases?.join(', ') || '_none_'}`);
    L.push(`- **releaseYear**: ${result.extraction.releaseYear ?? '_not extracted_'}`);
    L.push(`- **externalId**: ${result.extraction.externalId ?? '_not extracted_'}`);
    L.push(
      `- **siblingIds**: ${result.extraction.siblingIds?.join(', ') ?? '_not extracted_'}`,
    );
    L.push(`- **imageUrls**: ${result.extraction.imageUrls.length} found`);
    L.push(`- **rawOffers**: ${result.extraction.rawOffers.length} found`);
    L.push('');
    L.push('### Identifiers (per offer)');
    L.push(
      '_What identity resolution looks up before any LLM call: GTIN across every shop, MPN within the brand, declared siblings within this source._',
    );
    if (result.identifiers.length === 0) L.push('_No offers extracted._');
    result.identifiers.forEach((identifiers, index) => {
      L.push(`- offer ${index + 1}`);
      L.push(...formatListingIdentifiers(identifiers, '  '));
    });
    L.push('');
    L.push('### rawSpecs');
    L.push('```json');
    L.push(JSON.stringify(result.extraction.rawSpecs, null, 2));
    L.push('```');
    L.push('');

    if (result.category) {
      L.push('## Category Resolution');
      L.push(`- **slug**: ${result.category.slug}`);
      L.push(`- **found in DB**: ${result.category.found}`);
      L.push(`- **enabled in config.categories**: ${result.category.enabled}`);
      L.push(`- **has JSON schema**: ${result.category.hasJsonSchema}`);
      L.push('');
    }

    if (result.specs) {
      L.push('## Specs');
      L.push('### Deterministic (SpecExtractionService)');
      L.push('```json');
      L.push(JSON.stringify(result.specs.deterministic, null, 2));
      L.push('```');
      L.push('### Identity extraction (the fields that decide which product this is)');
      L.push('```json');
      L.push(JSON.stringify(result.specs.identity, null, 2));
      L.push('```');
      L.push('### Spec unification (what it adds when this page creates a product)');
      L.push('```json');
      L.push(JSON.stringify(result.specs.unification, null, 2));
      L.push('```');
      L.push('### Merged (final)');
      L.push('```json');
      L.push(JSON.stringify(result.specs.merged, null, 2));
      L.push('```');
      L.push('');
    }

    if (result.brandResolution) {
      L.push('## Brand Resolution');
      L.push(`- **queried**: ${result.brandResolution.queriedName ?? '_none_'}`);
      L.push(`- **matched existing brand**: ${result.brandResolution.matched}`);
      if (result.brandResolution.matched) {
        L.push(`- **resolved to**: ${result.brandResolution.resolvedName}`);
        L.push(`- **similarity**: ${result.brandResolution.similarity?.toFixed(3)}`);
      }
      L.push('');
    }

    if (result.productPreview) {
      L.push('## Final Product Model Preview');
      L.push('_This is what the ProductModel would look like if this scrape were persisted — not saved anywhere._');
      L.push('```json');
      L.push(JSON.stringify(result.productPreview, null, 2));
      L.push('```');
    } else {
      L.push('_No product model preview — see errors above for why extraction did not reach that stage._');
    }

    return L.join('\n');
  }
}
