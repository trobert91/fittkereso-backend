import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductSource,
  ProductSourceConfigValidatorService,
  ProductSourceRepository,
  SellerRepository,
  systemActor,
  PRODUCT_SOURCE_TYPES,
  ProductSourceType,
  DEFAULT_PRODUCT_SOURCE_FETCH_MODE,
  PRODUCT_SOURCE_FETCH_MODES,
  ProductSourceFetchMode,
} from '@fittkereso-backend/database';
import {
  ProductSourceUpdateParams,
  ProductSourceUpdateService,
  ProductSourceVersionService,
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
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
  ) {}

  // ─── Config schema tools ───────────────────────────────────────────────────

  @Tool({
    name: 'get_product_source_config_schema',
    description:
      'Get the JSON Schema a ProductSource config is validated against. There is one schema PER SOURCE TYPE — "scraping" (startUrls, listPage, detailPage pipelines) and the feed types "arukereso" and "googleshop" (feedUrl, field mapping; the two share one schema) share no keys — so pass the type you are writing. Omit it to get every schema keyed by type. Documents the whole config shape and every scrape operation with its required and optional parameters. Read this BEFORE hand-writing or editing a config: update_product_source rejects anything that does not match, and copying the shape from an existing config only shows the ops that config happens to use.',
    parameters: z.object({
      type: z
        .enum(PRODUCT_SOURCE_TYPES)
        .optional()
        .describe('Which type\'s schema to return. Omit for all of them.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async getProductSourceConfigSchema(args: {
    type?: ProductSourceType;
  }): Promise<string> {
    const schema = args?.type
      ? this.configValidator.schemaFor(args.type)
      : this.configValidator.allSchemas;

    return JSON.stringify(schema, null, 2);
  }

  @Tool({
    name: 'validate_all_product_source_configs',
    description:
      'Check every stored ProductSource.config against the config schema and report which sources do not conform. Read-only. Use it to find sources that need fixing — a non-conforming config fails its scrape and sync tasks outright rather than being scraped with the broken part skipped.',
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async validateAllProductSourceConfigs(): Promise<string> {
    const sources = await this.productSourceRepo.find({
      relations: { seller: true },
    });

    if (!sources.length) {
      return 'No product sources exist.';
    }

    const lines: string[] = [];
    let invalid = 0;
    let unconfigured = 0;

    for (const source of sources) {
      // A source created but never configured holds `{}` — the column default.
      // Reported apart from a broken config: nothing is wrong with it yet, it
      // simply has not been filled in, and it cannot run either way.
      if (!source.config || Object.keys(source.config).length === 0) {
        unconfigured += 1;
        lines.push(`- ${source.name} (${source.id}): no config yet`);
        continue;
      }

      const problems = this.configValidator.problems(source.type, source.config);
      if (!problems) continue;

      invalid += 1;
      lines.push(`- ${source.name} (${source.id}): ${problems.length} problem(s)`);
      lines.push(...problems.map((problem) => `    ${problem.path}: ${problem.message}`));
    }

    const header =
      `Checked ${sources.length} product source(s): ` +
      `${sources.length - invalid - unconfigured} valid, ${invalid} invalid, ${unconfigured} unconfigured.`;

    return lines.length ? `${header}\n\n${lines.join('\n')}` : header;
  }

  @Tool({
    name: 'validate_product_source_config',
    description:
      'Check a ProductSourceConfig against the config schema WITHOUT saving anything. Use it while drafting, so a structural mistake is found before update_product_source refuses the write. Reports every problem with the JSON path it is at.',
    parameters: z.object({
      type: z
        .enum(PRODUCT_SOURCE_TYPES)
        .describe(
          'Which schema to check against — the config shape is type-bound, so a scraping config checked as "arukereso" or "googleshop" fails on every key.',
        ),
      config: z
        .record(z.string(), z.any())
        .describe('The complete ProductSourceConfig JSON object to check.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async validateProductSourceConfig(args: {
    type: ProductSourceType;
    config: Record<string, unknown>;
  }): Promise<string> {
    const problems = this.configValidator.problems(args.type, args.config);

    if (!problems) {
      return 'Valid — this config matches the product source config schema.';
    }

    const lines = problems.map((problem) => `- ${problem.path}: ${problem.message}`);
    return `Invalid — ${problems.length} problem(s):\n${lines.join('\n')}`;
  }

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
      L.push(`- Type: ${source.type} · Fetch mode: ${source.fetchMode}`);
      L.push(
        `- Priority: ${source.priority} · Identifies products: ${source.identifiesProducts ? 'yes' : 'no'} · Has all products: ${source.hasAllProducts ? 'yes' : 'no'}`,
      );
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
      'Create a new ProductSource for a seller. Takes a name and a type — the created source starts with scheduling and processing both disabled, and an empty config. The type decides which config format the source uses and CANNOT be changed afterwards, so pick it deliberately: "scraping" drives page pipelines (startUrls, listPage, detailPage); "arukereso" (an Árukereső XML/CSV feed) and "googleshop" (a Google Shopping TSV feed) drive a product-feed mapping (feedUrl, mapping, where a target may list fallbacks: the first non-empty value wins). One seller may have several sources: the higher priority overwrites the lower one field by field, priorities are unique per seller, and at least one source per seller identifies products (creates products and offers) while the others only contribute to the offers it created. Use update_product_source afterward to fill in the config and enable scheduling/processing once it is ready.',
    parameters: z.object({
      sellerId: z.string().describe('Seller UUID to attach the new source to'),
      name: z.string().min(1).describe('Unique name for the product source'),
      type: z
        .enum(PRODUCT_SOURCE_TYPES)
        .describe(
          'Import type — "scraping", "arukereso" or "googleshop". Create-only: it cannot be changed later, because each type has its own config format.',
        ),
      priority: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Unique per seller; higher wins field by field. Omit for 10 on a seller's first source, else 10 below the seller's lowest.",
        ),
      identifiesProducts: z
        .boolean()
        .optional()
        .describe(
          "Default true. Off: the source only contributes prices, specs and descriptions to the offers an identifying source of the seller created, matched by externalId, and waits unattached otherwise. A seller's first source must identify.",
        ),
      hasAllProducts: z
        .boolean()
        .optional()
        .describe(
          "Default false. The source lists the shop's whole catalog for its enabled categories, so a complete run may remove the offers it did not see. Feed sources only.",
        ),
      fetchMode: z
        .enum(PRODUCT_SOURCE_FETCH_MODES)
        .optional()
        .describe(
          `How every page and feed of the source is fetched. Default "${DEFAULT_PRODUCT_SOURCE_FETCH_MODE}": through Zyte, paid. "direct": from the shop itself, free — only for a shop that agreed to be read, or for a feed over 10 MB, which Zyte truncates.`,
        ),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async createProductSourceForSeller(args: {
    sellerId: string;
    name: string;
    type: ProductSourceType;
    priority?: number;
    identifiesProducts?: boolean;
    hasAllProducts?: boolean;
    fetchMode?: ProductSourceFetchMode;
  }): Promise<string> {
    try {
      const { sellerId, ...dto } = args;
      const source = await this.createService.createForSeller(sellerId, dto);

      return `Product source "${source.name}" created (${source.id}, type "${source.type}", fetch mode "${source.fetchMode}", priority ${source.priority}, identifies products: ${source.identifiesProducts}, has all products: ${source.hasAllProducts}) for seller ${sellerId}. Scheduling and processing are both disabled — use update_product_source to configure and enable it.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to create product source "${args.name}": ${message}`;
    }
  }

  @Tool({
    name: 'update_product_source',
    description:
      'Update an existing ProductSource — name, scraping config (full replace), scheduling/processing enabled flags, priority (unique per seller), identifiesProducts / hasAllProducts, fetchMode (Zyte or direct), throttling (maxConcurrent, requestsPerHour), the full sync interval (an ms-compatible string like "6h", "30m"; pass null or empty string to clear), and detailRefreshInterval (how old a known listing\'s detail import may get, default "60 days"). Only fields provided are changed. A `config` is validated against the product source config schema and the whole update is refused if it does not match — use get_product_source_config_schema and validate_product_source_config while drafting.',
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
      priority: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Unique per seller; higher wins field by field over the seller's other sources."),
      identifiesProducts: z
        .boolean()
        .optional()
        .describe(
          'Whether this source creates products and offers. Refused when it would leave the seller with no identifying source.',
        ),
      hasAllProducts: z
        .boolean()
        .optional()
        .describe(
          'Whether the source lists the whole catalog, so a complete run may remove unseen offers. Feed sources only.',
        ),
      fetchMode: z
        .enum(PRODUCT_SOURCE_FETCH_MODES)
        .optional()
        .describe(
          '"proxied": every page and feed goes through Zyte, paid. "direct": fetched from the shop itself, free — only for a shop that agreed to be read, or for a feed over 10 MB, which Zyte truncates. Check a switch first with simulate_product_source_import and its fetchMode override.',
        ),
      maxConcurrent: z.number().int().min(1).optional(),
      requestsPerHour: z.number().int().min(1).optional(),
      frequency: z
        .string()
        .nullable()
        .optional()
        .describe('ms-compatible interval, e.g. "6h" or "1d"; null/empty clears it'),
      detailRefreshInterval: z
        .string()
        .optional()
        .describe(
          'ms-compatible interval, e.g. "60 days" (the default) or "8w": how old a known listing\'s detail import may get before its detail page is fetched again, even though its list card could refresh it in place. Acts on scraping sources\' list cards. Cannot be cleared.',
        ),
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
    identifiesProducts?: boolean;
    hasAllProducts?: boolean;
    fetchMode?: ProductSourceFetchMode;
    maxConcurrent?: number;
    requestsPerHour?: number;
    frequency?: string | null;
    detailRefreshInterval?: string;
  }): Promise<string> {
    try {
      const { productSourceId, ...params } = args;
      // updateService loads and returns the `seller` relation, so formatSource
      // can report the seller link without a re-fetch.
      const source = await this.updateService.updateProductSource(
        productSourceId,
        // A system actor rather than a user: the MCP server authenticates as
        // the server, not as a person, so attributing the change to any
        // particular admin would be an invention. The label says which path
        // wrote it, which is the honest answer.
        // The config arrives from a tool call as an untyped object, so the
        // cast is unavoidable here — and harmless, because updateProductSource
        // validates it against the config schema before storing it. The
        // compiler cannot vouch for this shape; the validator can.
        { ...params, actor: systemActor('mcp') } as unknown as ProductSourceUpdateParams,
      );

      return `Product source "${source.name}" (${source.id}) updated.\n\n${this.formatSource(source)}`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to update product source ${args.productSourceId}: ${message}`;
    }
  }

  // ─── Config version tools ──────────────────────────────────────────────────

  @Tool({
    name: 'list_product_source_versions',
    description:
      'List a ProductSource\'s config history, newest version first. Every config change writes a version, and the highest number is the one in force. Shows who made each one and any note, but not the configs themselves — use get_product_source_version for one.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      take: z.number().int().min(1).max(100).optional().describe('Page size, default 25'),
      skip: z.number().int().min(0).optional().describe('How many to skip, default 0'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async listProductSourceVersions(args: {
    productSourceId: string;
    take?: number;
    skip?: number;
  }): Promise<string> {
    const [versions, total] = await this.versionService.listVersions(
      args.productSourceId,
      { take: args.take, skip: args.skip },
    );

    if (!total) {
      return 'This product source has no config versions yet.';
    }

    const current = versions[0]?.version;
    const lines = versions.map((version) => {
      const parts = [`v${version.version}`];
      if (version.version === current && !args.skip) parts.push('(in force)');
      parts.push(version.createdAt?.toISOString() ?? 'unknown date');
      parts.push(this.describeActor(version));
      if (version.restoredFromVersion) {
        parts.push(`restored from v${version.restoredFromVersion}`);
      }
      if (version.note) parts.push(`"${version.note}"`);
      return `- ${parts.join(' · ')}`;
    });

    return `${total} version(s):\n${lines.join('\n')}`;
  }

  @Tool({
    name: 'get_product_source_version',
    description:
      'Get one numbered config version of a ProductSource, including the complete config JSON as it was at that revision. Use it to inspect what changed, or to read a config back before restoring it.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      version: z.number().int().min(1).describe('The version number to fetch'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async getProductSourceVersion(args: {
    productSourceId: string;
    version: number;
  }): Promise<string> {
    const version = await this.versionService.getVersion(
      args.productSourceId,
      args.version,
    );

    const header = [
      `# Version ${version.version}`,
      `Created: ${version.createdAt?.toISOString() ?? 'unknown'}`,
      `By: ${this.describeActor(version)}`,
      version.restoredFromVersion
        ? `Restored from: v${version.restoredFromVersion}`
        : null,
      version.note ? `Note: ${version.note}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return `${header}\n\n\`\`\`json\n${JSON.stringify(version.config, null, 2)}\n\`\`\``;
  }

  @Tool({
    name: 'restore_product_source_version',
    description:
      'Put an earlier config version back into force. This writes a NEW version carrying the old config rather than moving or deleting anything — restoring v2 while v5 is current produces v6, v2 and v5 both stay in the history, and the restore is itself reversible.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      version: z.number().int().min(1).describe('The version number to restore FROM'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async restoreProductSourceVersion(args: {
    productSourceId: string;
    version: number;
  }): Promise<string> {
    try {
      const restored = await this.versionService.restoreVersion(
        args.productSourceId,
        args.version,
        systemActor('mcp'),
      );

      // The restore answers with the whole source; the version it just wrote
      // is the newest one on it, which is what the history is ordered by.
      const created = restored.versions?.[0]?.version;

      return `Restored version ${args.version}${created ? ` as new version ${created}` : ''}. The product source now runs the config from v${args.version}.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to restore version ${args.version}: ${message}`;
    }
  }

  @Tool({
    name: 'get_product_source_history',
    description:
      'The audit timeline for a ProductSource: config versions written and restored, syncs triggered, scheduling/processing toggled, seller changes, and any run-time config validation failures. Newest first.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      take: z.number().int().min(1).max(100).optional().describe('Page size, default 25'),
      skip: z.number().int().min(0).optional().describe('How many to skip, default 0'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async getProductSourceHistory(args: {
    productSourceId: string;
    take?: number;
    skip?: number;
  }): Promise<string> {
    const [actions, total] = await this.versionService.listActions(
      args.productSourceId,
      { take: args.take, skip: args.skip },
    );

    if (!total) {
      return 'This product source has no recorded history yet.';
    }

    const lines = actions.map((action) => {
      const when = action.occurredAt?.toISOString() ?? 'unknown date';
      const payload = Object.keys(action.payload ?? {}).length
        ? ` ${JSON.stringify(action.payload)}`
        : '';
      return `- ${when} · ${action.type} · ${this.describeActor(action)}${payload}`;
    });

    return `${total} entr(ies):\n${lines.join('\n')}`;
  }

  /**
   * Who did something, preferring the live account over the frozen label so a
   * rename shows through, and falling back to the label once the account is
   * gone. Never invents a name for a system row.
   */
  private describeActor(row: {
    actorType: string;
    actorUser?: { name?: string; email?: string } | null;
    actorLabel?: string | null;
  }): string {
    if (row.actorType === 'system') {
      return `system${row.actorLabel ? ` (${row.actorLabel})` : ''}`;
    }

    return (
      row.actorUser?.name ||
      row.actorUser?.email ||
      row.actorLabel ||
      'a deleted account'
    );
  }

  // ─── Fetch Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'fetch_website_html',
    description:
      'Fetch the raw HTML of a real, publicly reachable URL — via the Zyte extract API by default, or directly from the shop. Use this to inspect a seller\'s website before drafting or hand-writing a ProductSourceConfig scraping pipeline — e.g. fetch a product listing page or a product detail page and read the returned HTML to figure out selectors. Returns the HTML truncated to a safe length for the response; note the truncation if it happens.',
    parameters: z.object({
      url: z.string().url().describe('Full URL to fetch, e.g. a category or product page'),
      maxLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max characters of HTML to return, default 20000'),
      fetchMode: z
        .enum(PRODUCT_SOURCE_FETCH_MODES)
        .optional()
        .describe(
          `Default "${DEFAULT_PRODUCT_SOURCE_FETCH_MODE}" (Zyte, paid). "direct" calls the shop itself — only for a shop that agreed to be read, e.g. to check that it answers us before switching its source to direct.`,
        ),
    }),
    annotations: { readOnlyHint: true },
  })
  async fetchWebsiteHtml(args: {
    url: string;
    maxLength?: number;
    fetchMode?: ProductSourceFetchMode;
  }): Promise<string> {
    const maxLength = args.maxLength ?? 20000;
    const fetchMode = args.fetchMode ?? DEFAULT_PRODUCT_SOURCE_FETCH_MODE;

    try {
      const html = await this.scraperService.getHtml(args.url, fetchMode);
      const truncated = html.length > maxLength;
      const body = truncated ? html.slice(0, maxLength) : html;

      const L: string[] = [];
      L.push(`# HTML for ${args.url} (${fetchMode})`);
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
    L.push(`- **Type**: ${source.type}`);
    L.push(`- **Seller**: ${source.seller?.name ?? '_none_'} ${source.seller ? `(${source.seller.id})` : ''}`);
    L.push(`- **Scheduling enabled**: ${source.schedulingEnabled}`);
    L.push(`- **Processing enabled**: ${source.processingEnabled}`);
    L.push(`- **Priority**: ${source.priority}`);
    L.push(`- **Identifies products**: ${source.identifiesProducts}`);
    L.push(`- **Has all products**: ${source.hasAllProducts}`);
    L.push(`- **Fetch mode**: ${source.fetchMode}`);
    L.push(`- **Max concurrent**: ${source.maxConcurrent}`);
    L.push(`- **Requests per hour**: ${source.requestsPerHour}`);
    L.push(`- **Frequency**: ${source.frequency ?? '_not set_'}`);
    L.push(`- **Detail refresh interval**: ${source.detailRefreshInterval}`);
    L.push(`- **Next run**: ${source.nextRunAt?.toISOString() ?? '_not scheduled_'}`);
    L.push(`- **Last run**: ${source.lastRunAt?.toISOString() ?? '_never_'}`);
    L.push('');
    L.push('## Config');
    L.push('```json');
    L.push(JSON.stringify(source.config ?? {}, null, 2));
    L.push('```');

    return L.join('\n');
  }
}
