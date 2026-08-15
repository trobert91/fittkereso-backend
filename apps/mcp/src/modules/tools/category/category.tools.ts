import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductCategory,
  ProductCategoryRepository,
  ProductModelRepository,
  ProductSourceRepository,
  type ProductCategoryConfig,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { generateSlug } from '@fittkereso-backend/utils';

@Injectable()
export class CategoryTools {
  constructor(
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  // ─── Read Tools ────────────────────────────────────────────────────────────

  @Tool({
    name: 'get_category_detail',
    description:
      'Get full category detail — hierarchy, product counts, complete config (matching, prompt config), jsonSchema, uiSchema, specMappings, and raw config JSON. One-stop tool for inspecting everything about a category.',
    parameters: z.object({
      categoryId: z.string().describe('Product category UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getCategoryDetail(args: { categoryId: string }): Promise<string> {
    const category = await this.categoryRepo.findOneOrFail({
      where: { id: args.categoryId },
    });

    const totalProducts = await this.productRepo.repo.count({
      where: { productCategory: { id: args.categoryId } },
    });
    const enabledProducts = await this.productRepo.repo.count({
      where: { productCategory: { id: args.categoryId }, enabled: true },
    });

    const slug = category.slug;
    const config = slug
      ? this.categoryConfigService.getConfig(slug)
      : undefined;
    const jsonSchema = slug
      ? this.categoryConfigService.getJsonSchema(slug)
      : undefined;
    const uiSchema = slug
      ? this.categoryConfigService.getUiSchema(slug)
      : undefined;
    const specMappings = slug
      ? await this.getSpecMappingsForCategory(slug)
      : undefined;

    const L: string[] = [];

    // ─── Header ────────────────────────────────────────────────────────
    L.push(`# Category Detail: ${category.name}`);
    L.push(`- **ID**: ${category.id}`);
    L.push(`- **Slug**: ${slug ?? '_not set_'}`);
    L.push(`- **Enabled**: ${category.enabled}`);
    if (category.aliases?.length) {
      L.push(`- **Aliases**: ${category.aliases.join(', ')}`);
    }
    L.push('');

    // ─── Products ──────────────────────────────────────────────────────
    L.push('## Products');
    L.push(`- **Total**: ${totalProducts}`);
    L.push(`- **Enabled**: ${enabledProducts}`);
    L.push('');

    // ─── Config Completeness ───────────────────────────────────────────
    L.push('## Config Completeness');
    this.appendConfigCompleteness(L, config);
    L.push('');

    // ─── Config Values ─────────────────────────────────────────────────
    this.appendConfigValues(L, config ?? {});

    // ─── Raw Config JSON ───────────────────────────────────────────────
    L.push('## Raw Config');
    L.push('```json');
    L.push(JSON.stringify(config ?? {}, null, 2));
    L.push('```');
    L.push('');

    // ─── JSON Schema ───────────────────────────────────────────────────
    L.push('## JSON Schema');
    if (jsonSchema) {
      L.push('```json');
      L.push(JSON.stringify(jsonSchema, null, 2));
      L.push('```');
    } else {
      L.push('_Not set_');
    }
    L.push('');

    // ─── UI Schema ─────────────────────────────────────────────────────
    L.push('## UI Schema');
    if (uiSchema) {
      L.push('```json');
      L.push(JSON.stringify(uiSchema, null, 2));
      L.push('```');
    } else {
      L.push('_Not set_');
    }
    L.push('');

    // ─── Spec Mappings ─────────────────────────────────────────────────
    if (specMappings) {
      L.push('## Spec Mappings');
      for (const [source, sourceConfig] of Object.entries(specMappings)) {
        L.push(`### ${source}`);
        L.push(`- **Mappings**: ${sourceConfig.mappings?.length ?? 0} entries`);
        L.push(
          `- **Calculated**: ${sourceConfig.calculated?.length ?? 0} rules`,
        );
      }
      L.push('');
    }

    return L.join('\n');
  }

  @Tool({
    name: 'list_categories_with_config',
    description:
      'List all product categories with their keywordIdentifiers. Use this to audit all categories at once without calling get_category_detail 56 times.',
    parameters: z.object({}),
    annotations: { readOnlyHint: true },
  })
  async listCategoriesWithConfig(): Promise<string> {
    const categories = await this.categoryRepo.find({
      order: { name: 'ASC' },
    });

    const L: string[] = [];
    L.push(`# All Categories with Config (${categories.length} total)`);
    L.push('');

    for (const category of categories) {
      const config = category.slug
        ? (this.categoryConfigService.getConfig(category.slug) ?? {})
        : {};

      L.push(`## ${category.name} (${category.id})`);
      L.push(`Enabled: ${category.enabled}`);

      const keywordIds = config.keywordIdentifiers ?? [];
      L.push(
        `Keywords: ${keywordIds.length > 0 ? keywordIds.map((keyword) => `\`${keyword}\``).join(', ') : '—'}`,
      );

      L.push('');
    }

    return L.join('\n');
  }

  // ─── Write Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'create_category',
    description:
      'Create a new product category with an enabled flag. Config must be added separately by creating libs/config/src/lib/categories/<slug>/config.json.',
    parameters: z.object({
      name: z.string().describe('Unique category name'),
      enabled: z
        .boolean()
        .optional()
        .describe('Whether the category is enabled (default: true)'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async createCategory(args: {
    name: string;
    enabled?: boolean;
  }): Promise<string> {
    const existing = await this.categoryRepo.findByName(args.name);
    if (existing) {
      return `Category "${args.name}" already exists (${existing.id}).`;
    }

    const category = new ProductCategory();
    category.name = args.name;
    category.enabled = args.enabled ?? true;

    const saved = await this.categoryRepo.save(category);

    // Generate slug after save (we need the ID)
    await this.generateCategorySlug(saved);
    await this.categoryRepo.save(saved);

    return `Category "${saved.name}" created successfully (${saved.id}). Add config at libs/config/src/lib/categories/${saved.slug}/config.json.`;
  }

  @Tool({
    name: 'update_category',
    description:
      'Update database entity fields of an existing category — name, enabled, aliases. All file-based config (config.json, jsonSchema.json, uiSchema.json, specMappings.json) must be edited directly in libs/config/src/lib/categories/<slug>/.',
    parameters: z.object({
      categoryId: z.string().describe('Category UUID to update'),
      name: z.string().optional().describe('New unique name for the category'),
      enabled: z
        .boolean()
        .optional()
        .describe('Enable or disable the category'),
      aliases: z
        .array(z.string())
        .optional()
        .describe('Alias strings for this category (replaces existing list)'),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  })
  async updateCategory(args: {
    categoryId: string;
    name?: string;
    enabled?: boolean;
    aliases?: string[];
  }): Promise<string> {
    const category = await this.categoryRepo.findOneOrFail({
      where: { id: args.categoryId },
    });

    const changes: string[] = [];

    if (args.name !== undefined) {
      const existing = await this.categoryRepo.findByName(args.name);
      if (existing && existing.id !== args.categoryId) {
        return `Cannot rename: a category named "${args.name}" already exists (${existing.id}).`;
      }
      category.name = args.name;
      changes.push('name');
    }

    if (args.enabled !== undefined) {
      category.enabled = args.enabled;
      changes.push('enabled');
    }

    if (args.aliases !== undefined) {
      category.aliases = args.aliases;
      changes.push('aliases');
    }

    await this.generateCategorySlug(category);
    await this.categoryRepo.save(category);

    if (changes.length === 0) {
      return `No changes specified for category "${category.name}" (${args.categoryId}).`;
    }

    return `Category "${category.name}" (${args.categoryId}) updated. Changed: ${changes.join(', ')}.`;
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private appendConfigCompleteness(
    lines: string[],
    config: ProductCategoryConfig | undefined,
  ): void {
    // Matching config
    const matchingConfig = config?.matchingConfig;
    if (matchingConfig) {
      const parts: string[] = [];
      if (matchingConfig.strictness)
        parts.push(`strictness: ${matchingConfig.strictness}`);
      if (matchingConfig.numericTokenRules?.length)
        parts.push(`${matchingConfig.numericTokenRules.length} numeric rules`);
      lines.push(`- **Matching Config**: Yes (${parts.join(', ')})`);
    } else {
      lines.push('- **Matching Config**: No');
    }

    // Keyword identifiers
    const keywords = config?.keywordIdentifiers;
    lines.push(
      `- **Keyword Identifiers**: ${keywords?.length ? keywords.join(', ') : 'No'}`,
    );
  }

  private appendConfigValues(
    lines: string[],
    config: ProductCategoryConfig,
  ): void {
    // Keyword identifiers
    if (config.keywordIdentifiers && config.keywordIdentifiers.length > 0) {
      lines.push('## Keyword Identifiers');
      lines.push(
        config.keywordIdentifiers.map((keyword) => `\`${keyword}\``).join(', '),
      );
      lines.push('');
    }

    // Matching config
    if (config.matchingConfig) {
      lines.push('## Matching Config');
      lines.push('```json');
      lines.push(JSON.stringify(config.matchingConfig, null, 2));
      lines.push('```');
      lines.push('');
    }

    // Prompt config
    if (config.promptConfig?.searchKeywordSuffix) {
      lines.push('## Prompt Config');
      lines.push(
        `**Search keyword suffix:** ${config.promptConfig.searchKeywordSuffix}`,
      );
      lines.push('');
    }
  }

  // Spec mappings now live per-ProductSource (config.detailPage.specMapping,
  // keyed by category slug) rather than in a per-category specMappings.json
  // file keyed by source. Collect the mapping for this category slug across
  // every configured source.
  private async getSpecMappingsForCategory(
    slug: string,
  ): Promise<Record<string, { mappings?: unknown[]; calculated?: unknown[] }>> {
    const sources = await this.productSourceRepo.getAll();
    const result: Record<string, { mappings?: unknown[]; calculated?: unknown[] }> = {};

    for (const source of sources) {
      const mapping = source.config?.detailPage?.specMapping?.[slug];
      if (mapping) {
        result[source.name] = mapping;
      }
    }

    return result;
  }

  private async generateCategorySlug(entity: ProductCategory): Promise<void> {
    let slug = generateSlug(entity.id, entity.name);
    const existing = await this.categoryRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }
}
