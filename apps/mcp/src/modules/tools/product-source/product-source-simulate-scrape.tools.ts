import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ProductSourceConfig, ProductSourceRepository } from '@fittkereso-backend/database';
import {
  ProductSourceSimulationResult,
  ProductSourceSimulationService,
} from '@fittkereso-backend/product-scraper';

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
  }): Promise<string> {
    let config: ProductSourceConfig;
    if (args.productSourceId) {
      const source = await this.productSourceRepo.findOneOrFail({
        where: { id: args.productSourceId },
      });
      if (!source.config?.detailPage) {
        return `Product source ${args.productSourceId} has no detailPage config yet — nothing to simulate.`;
      }
      config = source.config;
    } else {
      config = args.config as unknown as ProductSourceConfig;
      if (!config?.detailPage) {
        return 'The given config has no detailPage pipeline — nothing to simulate.';
      }
    }

    try {
      const result = await this.simulationService.simulateDetailPageScrape(args.url, config);
      return this.formatResult(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Simulation failed: ${message}`;
    }
  }

  private formatResult(result: ProductSourceSimulationResult): string {
    const L: string[] = [];
    L.push(`# Scrape Simulation: ${result.url}`);
    L.push(`- **HTML fetched**: ${result.html.length} chars`);
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
    L.push(`- **imageUrls**: ${result.extraction.imageUrls.length} found`);
    L.push(`- **rawOffers**: ${result.extraction.rawOffers.length} found`);
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
      if (result.specs.llmContribution) {
        L.push('### LLM Post-Process Contribution');
        L.push('```json');
        L.push(JSON.stringify(result.specs.llmContribution, null, 2));
        L.push('```');
      }
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
