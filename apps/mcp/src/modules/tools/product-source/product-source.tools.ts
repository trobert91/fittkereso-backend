import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductSource,
  ProductSourceRepository,
  SellerRepository,
} from '@fittkereso-backend/database';
import {
  ProductSourceUpdateService,
  SellerProductSourceCreateService,
} from '@fittkereso-backend/product';
import {
  ProductSourceSearchParams,
  ProductSourceSearchService,
} from '@fittkereso-backend/search';
import { ScraperService } from '@fittkereso-backend/scraper';

@Injectable()
export class ProductSourceTools {
  constructor(
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly sellerRepo: SellerRepository,
    private readonly searchService: ProductSourceSearchService,
    private readonly createService: SellerProductSourceCreateService,
    private readonly updateService: ProductSourceUpdateService,
    private readonly scraperService: ScraperService,
  ) {}

  // ─── Read Tools ────────────────────────────────────────────────────────────

  @Tool({
    name: 'get_product_source',
    description:
      'Get full detail of a single ProductSource by id — name, seller, scheduling/processing flags, throttling settings, sync timestamps/intervals, and the raw scraping config JSON (baseUrl, listPage/detailPage scrape-operation pipelines, etc.).',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductSource(args: { productSourceId: string }): Promise<string> {
    const source = await this.productSourceRepo.findOneOrFail({
      where: { id: args.productSourceId },
      relations: ['seller'],
    });

    return this.formatSource(source);
  }

  @Tool({
    name: 'list_product_sources_for_seller',
    description:
      'List all ProductSources belonging to a given seller (paginated). Use this to see what sources already exist for a seller before creating a new one, or to find the id of a source to update.',
    parameters: z.object({
      sellerId: z.string().describe('Seller UUID'),
      page: z.number().int().positive().optional().describe('Page number, default 1'),
      pageSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Results per page, default 100'),
    }),
    annotations: { readOnlyHint: true },
  })
  async listProductSourcesForSeller(args: {
    sellerId: string;
    page?: number;
    pageSize?: number;
  }): Promise<string> {
    const seller = await this.sellerRepo.findOneOrFail({
      where: { id: args.sellerId },
    });

    const params: ProductSourceSearchParams = {
      sellerId: args.sellerId,
      page: args.page,
      pageSize: args.pageSize,
    };
    const result = await this.searchService.search(params);

    const L: string[] = [];
    L.push(
      `# Product Sources for Seller: ${seller.name} (${result.totalItems ?? 0} total)`,
    );
    L.push(
      `Page ${result.page}/${result.totalPages} (pageSize ${result.pageSize})`,
    );
    L.push('');

    for (const source of result.items ?? []) {
      L.push(`## ${source.name} (${source.id})`);
      L.push(
        `- Scheduling: ${source.schedulingEnabled ? 'on' : 'off'} · Processing: ${source.processingEnabled ? 'on' : 'off'}`,
      );
      L.push(`- Priority: ${source.priority}`);
      L.push(`- Base URL: ${source.config?.baseUrl ?? '_not set_'}`);
      L.push('');
    }

    if (!result.items?.length) {
      L.push('_No product sources found for this seller._');
    }

    return L.join('\n');
  }

  // ─── Write Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'create_product_source_for_seller',
    description:
      'Create a new ProductSource for a seller. Only takes a name — the created source starts with scheduling and processing both disabled, and an empty config. Use update_product_source afterward to fill in the config (baseUrl, scrape-operation pipelines, etc.) and enable scheduling/processing once it is ready.',
    parameters: z.object({
      sellerId: z.string().describe('Seller UUID to attach the new source to'),
      name: z.string().min(1).describe('Unique name for the product source'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async createProductSourceForSeller(args: {
    sellerId: string;
    name: string;
  }): Promise<string> {
    const source = await this.createService.createForSeller(args.sellerId, {
      name: args.name,
    });

    return `Product source "${source.name}" created (${source.id}) for seller ${args.sellerId}. Scheduling and processing are both disabled — use update_product_source to configure and enable it.`;
  }

  @Tool({
    name: 'update_product_source',
    description:
      'Update an existing ProductSource — name, scraping config (full replace), scheduling/processing enabled flags, priority, throttling (maxConcurrent, requestsPerHour), and full/incremental sync intervals (ms-compatible strings like "6h", "30m"; pass null or empty string to clear). Only fields provided are changed.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID to update'),
      name: z.string().min(1).optional(),
      config: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'Full ProductSourceConfig JSON object — REPLACES the existing config entirely, so pass the complete object (fetch current config first via get_product_source if you only want to change part of it).',
        ),
      schedulingEnabled: z.boolean().optional(),
      processingEnabled: z.boolean().optional(),
      priority: z.number().int().min(0).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
      requestsPerHour: z.number().int().min(1).optional(),
      fullSyncInterval: z
        .string()
        .nullable()
        .optional()
        .describe('ms-compatible interval, e.g. "6h" or "1d"; null/empty clears it'),
      incrementalSyncInterval: z
        .string()
        .nullable()
        .optional()
        .describe('ms-compatible interval, e.g. "30m" or "2h"; null/empty clears it'),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  })
  async updateProductSource(args: {
    productSourceId: string;
    name?: string;
    config?: Record<string, unknown>;
    schedulingEnabled?: boolean;
    processingEnabled?: boolean;
    priority?: number;
    maxConcurrent?: number;
    requestsPerHour?: number;
    fullSyncInterval?: string | null;
    incrementalSyncInterval?: string | null;
  }): Promise<string> {
    try {
      const { productSourceId, ...params } = args;
      const source = await this.updateService.updateProductSource(
        productSourceId,
        params as never,
      );

      return `Product source "${source.name}" (${source.id}) updated.\n\n${this.formatSource(source)}`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to update product source ${args.productSourceId}: ${message}`;
    }
  }

  // ─── Fetch Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'fetch_website_html',
    description:
      'Fetch the raw HTML of a real, publicly reachable URL via the Zyte extract API. Use this to inspect a seller\'s website before drafting or hand-writing a ProductSourceConfig scraping pipeline — e.g. fetch a product listing page or a product detail page and read the returned HTML to figure out selectors. Returns the HTML truncated to a safe length for the response; note the truncation if it happens.',
    parameters: z.object({
      url: z.string().url().describe('Full URL to fetch, e.g. a category or product page'),
      maxLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max characters of HTML to return, default 20000'),
    }),
    annotations: { readOnlyHint: true },
  })
  async fetchWebsiteHtml(args: {
    url: string;
    maxLength?: number;
  }): Promise<string> {
    const maxLength = args.maxLength ?? 20000;

    try {
      const html = await this.scraperService.getHtml(args.url);
      const truncated = html.length > maxLength;
      const body = truncated ? html.slice(0, maxLength) : html;

      const L: string[] = [];
      L.push(`# HTML for ${args.url}`);
      L.push(`Length: ${html.length} chars${truncated ? ` (truncated to ${maxLength})` : ''}`);
      L.push('');
      L.push('```html');
      L.push(body);
      L.push('```');

      return L.join('\n');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to fetch ${args.url}: ${message}`;
    }
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private formatSource(source: ProductSource): string {
    const L: string[] = [];
    L.push(`# Product Source: ${source.name}`);
    L.push(`- **ID**: ${source.id}`);
    L.push(`- **Seller**: ${source.seller?.name ?? '_none_'} ${source.seller ? `(${source.seller.id})` : ''}`);
    L.push(`- **Scheduling enabled**: ${source.schedulingEnabled}`);
    L.push(`- **Processing enabled**: ${source.processingEnabled}`);
    L.push(`- **Priority**: ${source.priority}`);
    L.push(`- **Max concurrent**: ${source.maxConcurrent}`);
    L.push(`- **Requests per hour**: ${source.requestsPerHour}`);
    L.push(`- **Full sync interval**: ${source.fullSyncInterval ?? '_not set_'}`);
    L.push(`- **Next full sync**: ${source.nextFullSyncAt?.toISOString() ?? '_not scheduled_'}`);
    L.push(`- **Incremental sync interval**: ${source.incrementalSyncInterval ?? '_not set_'}`);
    L.push(`- **Next incremental sync**: ${source.nextIncrementalSyncAt?.toISOString() ?? '_not scheduled_'}`);
    L.push(`- **Last run**: ${source.lastRunAt?.toISOString() ?? '_never_'}`);
    L.push('');
    L.push('## Config');
    L.push('```json');
    L.push(JSON.stringify(source.config ?? {}, null, 2));
    L.push('```');

    return L.join('\n');
  }
}
