import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { AiChatRequest, AiChatService } from '@fittkereso-backend/ai';
import { ScraperService } from '@fittkereso-backend/scraper';

const DRAFT_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    baseUrl: {
      type: 'string',
      description:
        "The site's canonical base URL (scheme + host, no trailing slash), e.g. https://www.example.com",
    },
    fullSyncStartUrl: {
      type: 'string',
      description:
        'The URL a full catalog crawl should start from — typically a category listing, sitemap, or "all products" page. Omit if unclear.',
    },
    notes: {
      type: 'string',
      description:
        'Brief notes for the human who will write the scrape-operation pipelines: what the product listing pages look like, how product detail pages are structured, anything unusual (pagination style, JS-rendered content, anti-bot measures observed, etc.).',
    },
  },
  required: ['baseUrl'],
  additionalProperties: false,
};

interface DraftConfigResult {
  baseUrl: string;
  fullSyncStartUrl?: string;
  notes?: string;
}

@Injectable()
export class ProductSourceConfigGeneratorTools {
  constructor(
    private readonly scraperService: ScraperService,
    private readonly aiChatService: AiChatService,
  ) {}

  @Tool({
    name: 'generate_product_source_config_draft',
    description:
      'Fetch a real website page and ask an AI model to draft the SIMPLE top-level fields of a ProductSourceConfig (baseUrl, fullSyncStartUrl) plus human-readable notes about page structure. Does NOT generate the scrape-operation pipelines (listPage/detailPage selectors) — those are a complex declarative DSL that must be hand-written by a developer using the notes and page HTML as reference (see fetch_website_html and existing ProductSource configs for examples). This tool never saves anything — it only returns a draft for review; use update_product_source to actually apply it once you (or a human) have filled in the scraping pipelines.',
    parameters: z.object({
      url: z
        .string()
        .url()
        .describe(
          'A representative URL on the seller\'s site to inspect — ideally a product category/listing page.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Model identifier resolved via AiProviderRegistry (defaults to "gpt-5-mini" if omitted).',
        ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  })
  async generateProductSourceConfigDraft(args: {
    url: string;
    model?: string;
  }): Promise<string> {
    let html: string;
    try {
      html = await this.scraperService.getHtml(args.url);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to fetch ${args.url}: ${message}`;
    }

    const model = args.model ?? 'gpt-5-mini';
    const truncatedHtml = html.slice(0, 40000);

    const request: AiChatRequest = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are assisting a developer in configuring a new e-commerce scraping source (ProductSource) for a price-comparison platform. Given the raw HTML of a page from a seller\'s website, extract only the simple, unambiguous top-level facts requested by the schema. Do not guess at CSS selectors or scraping logic — that is out of scope and handled separately by a developer. If a field is not confidently determinable from the given HTML, omit it rather than guessing.',
        },
        {
          role: 'user',
          content: `Source URL: ${args.url}\n\nHTML (may be truncated):\n\n${truncatedHtml}`,
        },
      ],
      schema: DRAFT_CONFIG_SCHEMA,
      schemaName: 'product_source_config_draft',
      costLabel: 'mcp-product-source-config-draft',
    };

    try {
      const response = await this.aiChatService.createChat(request);
      const parsed = response.parsed as DraftConfigResult | undefined;

      const L: string[] = [];
      L.push(`# Product Source Config Draft`);
      L.push(`- **Source URL**: ${args.url}`);
      L.push(`- **Model**: ${response.model}`);
      if (response.cost !== undefined) {
        L.push(`- **Cost**: $${response.cost.toFixed(6)}`);
      }
      L.push('');

      if (!parsed) {
        L.push('## Raw response (schema validation unavailable)');
        L.push(response.content);
        return L.join('\n');
      }

      L.push('## Draft fields');
      L.push(`- **baseUrl**: ${parsed.baseUrl}`);
      L.push(`- **fullSyncStartUrl**: ${parsed.fullSyncStartUrl ?? '_not determined_'}`);
      if (parsed.notes) {
        L.push('');
        L.push('## Notes for the developer writing the scrape pipelines');
        L.push(parsed.notes);
      }

      L.push('');
      L.push('## Suggested partial config (still needs listPage/detailPage pipelines)');
      L.push('```json');
      L.push(
        JSON.stringify(
          {
            baseUrl: parsed.baseUrl,
            ...(parsed.fullSyncStartUrl && {
              fullSyncStartUrl: parsed.fullSyncStartUrl,
            }),
            listPage: { categoryName: [], categoryLinks: [], productLinks: [] },
            detailPage: {
              rawSpecs: [],
              category: { breadcrumbOrSource: [], slugLookup: [] },
              brand: [],
              model: [],
              images: [],
              specMapping: {},
            },
          },
          null,
          2,
        ),
      );
      L.push('```');
      L.push('');
      L.push(
        '_This is a draft, not saved anywhere. Review it, fetch further pages with fetch_website_html as needed, hand-write the scrape-operation pipelines (see libs/scrape-interpreter fixtures or an existing ProductSource\'s config for real examples), then call update_product_source with the completed config._',
      );

      return L.join('\n');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `AI config draft generation failed: ${message}`;
    }
  }
}
