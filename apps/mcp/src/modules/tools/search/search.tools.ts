import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductSearchService,
  ProductCategorySearchService,
  BrandSearchService,
  ProductSearchParams,
  CategorySearchParams,
  BrandSearchParams,
} from '@fittkereso-backend/search';
import { ProductCategoryRepository } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';

@Injectable()
export class SearchTools {
  constructor(
    private readonly productSearch: ProductSearchService,
    private readonly categorySearch: ProductCategorySearchService,
    private readonly brandSearch: BrandSearchService,
    private readonly categoryRepo: ProductCategoryRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  @Tool({
    name: 'search_products',
    description:
      'Search products by name, brand, or category. Returns product IDs, display names, brands, models. Use to find the correct product when resolution matched wrong one, or to verify product existence.',
    parameters: z.object({
      searchTerm: z
        .string()
        .optional()
        .describe('Search by product name (trigram similarity match)'),
      brandId: z.string().optional().describe('Filter by brand UUID'),
      categoryId: z.string().optional().describe('Filter by category UUID'),
      pageSize: z
        .number()
        .optional()
        .describe('Results per page (default 20, max 50)'),
    }),
    annotations: { readOnlyHint: true },
  })
  async searchProducts(args: {
    searchTerm?: string;
    brandId?: string;
    categoryId?: string;
    pageSize?: number;
  }): Promise<string> {
    const params = new ProductSearchParams();
    params.searchTerm = args.searchTerm;
    params.brandIds = args.brandId ? [args.brandId] : undefined;
    params.categoryIds = args.categoryId ? [args.categoryId] : undefined;
    params.pageSize = Math.min(args.pageSize ?? 20, 50);
    params.page = 1;

    const result = await this.productSearch.searchProducts(params);
    const items = result.items ?? [];

    if (items.length === 0) {
      return 'No products found matching the search criteria.';
    }

    const L: string[] = [];
    L.push(
      `# Product Search Results (${items.length} of ${result.totalItems ?? items.length})`,
    );
    L.push('');
    L.push('| ID | Display Name | Brand | Model | Category | Enabled |');
    L.push('|----|-------------|-------|-------|----------|---------|');

    for (const p of items) {
      const brand = p.brand?.name ?? '—';
      const category = p.productCategory?.name ?? '—';
      L.push(
        `| ${p.id} | ${p.displayName} | ${brand} | ${p.model} | ${category} | ${p.enabled} |`,
      );
    }

    return L.join('\n');
  }

  @Tool({
    name: 'search_categories',
    description:
      'Search product categories by name. Returns category IDs, names, parent info, and config completeness (matching config). Use to find category IDs needed by get_category_detail and search_products.',
    parameters: z.object({
      searchTerm: z
        .string()
        .optional()
        .describe(
          'Search by category name (trigram similarity match). Omit to list all categories.',
        ),
      pageSize: z
        .number()
        .optional()
        .describe('Results per page (default 50, max 100)'),
    }),
    annotations: { readOnlyHint: true },
  })
  async searchCategories(args: {
    searchTerm?: string;
    pageSize?: number;
  }): Promise<string> {
    const params = new CategorySearchParams();
    params.searchTerm = args.searchTerm;
    params.pageSize = Math.min(args.pageSize ?? 50, 100);
    params.page = 1;

    const result = await this.categorySearch.search(params);
    const items = result.items ?? [];

    if (items.length === 0) {
      return 'No categories found matching the search criteria.';
    }

    const L: string[] = [];
    L.push(
      `# Category Search Results (${items.length} of ${result.totalItems ?? items.length})`,
    );
    L.push('');
    L.push('| ID | Name | Enabled | Matching Config |');
    L.push('|----|------|---------|-----------------|');

    for (const item of items) {
      const matchingConfig = item.slug
        ? this.categoryConfigService.getConfig(item.slug)?.matchingConfig
        : undefined;

      const matchStatus = matchingConfig
        ? `Yes (${matchingConfig.strictness ?? 'default'})`
        : 'No';

      L.push(
        `| ${item.id} | ${item.name} | ${item.enabled} | ${matchStatus} |`,
      );
    }

    return L.join('\n');
  }

  @Tool({
    name: 'search_brands',
    description:
      'Search brands by name. Returns brand IDs needed to filter search_products.',
    parameters: z.object({
      searchTerm: z
        .string()
        .optional()
        .describe('Search by brand name (LIKE match). Omit to list all.'),
      pageSize: z
        .number()
        .optional()
        .describe('Results per page (default 50, max 100)'),
    }),
    annotations: { readOnlyHint: true },
  })
  async searchBrands(args: {
    searchTerm?: string;
    pageSize?: number;
  }): Promise<string> {
    const params = new BrandSearchParams();
    params.searchTerm = args.searchTerm;
    params.pageSize = Math.min(args.pageSize ?? 50, 100);
    params.page = 1;

    const result = await this.brandSearch.search(params);
    const items = result.items ?? [];

    if (items.length === 0) {
      return 'No brands found matching the search criteria.';
    }

    const L: string[] = [];
    L.push(
      `# Brand Search Results (${items.length} of ${result.totalItems ?? items.length})`,
    );
    L.push('');
    L.push('| ID | Name |');
    L.push('|----|------|');

    for (const b of items) {
      L.push(`| ${b.id} | ${b.name} |`);
    }

    return L.join('\n');
  }
}
