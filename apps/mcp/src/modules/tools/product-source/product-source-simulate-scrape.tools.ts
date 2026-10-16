import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  DEFAULT_PRODUCT_SOURCE_FETCH_MODE,
  isArukeresoConfig,
  isScrapingConfig,
  PRODUCT_SOURCE_FETCH_MODES,
  ProductSourceConfig,
  ProductSourceFetchMode,
  ProductSourceRepository,
} from '@fittkereso-backend/database';
import {
  ProductSourceSimulationResult,
  ProductSourceSimulationService,
} from '@fittkereso-backend/product-scraper';
import type { DetailPageSourceConfig } from '@fittkereso-backend/scrape-interpreter';
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
      "Dry-run a product detail page scrape against a real URL, using the generic scraper to fetch the page and the same interpreter/spec-extraction/post-process/brand-resolution pipeline the real scraper uses for detailPage — WITHOUT persisting anything (no ProductModel/Offer/ProductSourceRecord rows, no brand creation, no image copying). Returns the raw scrape-op extraction (rawSpecs, brand, model, images, offers), the resolved category, deterministic vs LLM-merged specs, brand-resolution outcome, and a preview of what the final product model would look like — plus warnings/errors explaining anything that would cause the real pipeline to skip or abort. Use this to validate/tune a ProductSourceConfig's detailPage pipeline (e.g. while drafting a new ProductSource) before saving it via update_product_source or create_product_source_for_seller. Also takes a feed source (\"arukereso\"/\"googleshop\") with a detailPage: its product page is read as its page task reads it, for the category its rows bring (categorySlug), and only its extraction and mapped specs are shown — the page fills what a feed row lacks.",
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
            "How to fetch the page: 'proxied' through Zyte (paid) or 'direct' from the shop (free, needs the shop's consent). Wins over everything; otherwise the config's detailPage.fetchMode, else the source's own fetchMode with productSourceId, else 'proxied' with an inline config. Pass 'direct' to check a shop before switching it to direct.",
          ),
        categorySlug: z
          .string()
          .optional()
          .describe(
            "Feed sources only: the category the page's rows are mapped for — a feed row brings its own. Defaults to the feed config's only enabled category section; required when it has several.",
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
    categorySlug?: string;
  }): Promise<string> {
    let config: ProductSourceConfig;
    let sourceFetchMode: ProductSourceFetchMode = DEFAULT_PRODUCT_SOURCE_FETCH_MODE;
    if (args.productSourceId) {
      const source = await this.productSourceRepo.findOneOrFail({
        where: { id: args.productSourceId },
      });
      config = source.config;
      sourceFetchMode = source.fetchMode;
    } else {
      config = args.config as unknown as ProductSourceConfig;
    }

    // A scraping source's detail pages, or — once it has a detailPage — a
    // feed source's product pages.
    const feed = isArukeresoConfig(config);
    const detailPage = feed || isScrapingConfig(config) ? config.detailPage : undefined;
    if (!detailPage) {
      return `${args.productSourceId ? `Product source ${args.productSourceId}` : 'The given config'} has no detailPage — nothing to simulate. A feed source reads its product pages once it has one.`;
    }
    const fetchMode = args.fetchMode ?? detailPage.fetchMode ?? sourceFetchMode;

    let feedCategorySlug: string | undefined;
    if (feed) {
      const enabled = Object.entries(config.categories ?? {})
        .filter(([, section]) => section?.enabled)
        .map(([slug]) => slug);
      feedCategorySlug = args.categorySlug ?? (enabled.length === 1 ? enabled[0] : undefined);
      if (!feedCategorySlug) {
        return `A feed's product page is read for the category its rows bring: pass categorySlug, one of ${enabled.join(', ') || '(no enabled category section)'}.`;
      }
    }

    try {
      const result = await this.simulationService.simulateDetailPageScrape(
        args.url,
        config as DetailPageSourceConfig,
        fetchMode,
        feedCategorySlug,
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
    if (result.feedPage) {
      L.push(
        `- **a feed source's product page**, its rows mapped for \`${result.feedPage.categorySlug}\`. It only fills what a feed row lacks: category, brand, title, price, stock and every value the row has stay the feed's. simulate_product_source_import previews the rows merged with their pages.`,
      );
    }
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
    // As the pipelines produced them: a mapped field that found nothing is
    // null, an unmapped one absent.
    const describe = (value: string | null | undefined) =>
      value === undefined ? '_not mapped_' : (value ?? '_none_');
    result.extraction.rawOffers.forEach((offer, index) => {
      L.push(
        `  - offer ${index + 1}: price ${offer.price ?? '_none_'} · old price ${offer.priceWithoutDiscount === undefined ? '_not mapped_' : (offer.priceWithoutDiscount ?? '_none_')} · availability ${describe(offer.availability)} · condition ${describe(offer.condition)}`,
      );
    });
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
      const section = (title: string, specs: Record<string, unknown> | undefined) => {
        if (!specs) return;
        L.push(`### ${title}`);
        L.push('```json');
        L.push(JSON.stringify(specs, null, 2));
        L.push('```');
      };
      L.push('## Specs');
      section('Deterministic (SpecExtractionService)', result.specs.deterministic);
      section('Identity extraction (the fields that decide which product this is)', result.specs.identity);
      section('Spec unification (what it adds when this page creates a product)', result.specs.unification);
      section('Merged (final)', result.specs.merged);
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
    } else if (!result.feedPage) {
      L.push('_No product model preview — see errors above for why extraction did not reach that stage._');
    }

    return L.join('\n');
  }
}
