import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { Seller, SellerRepository, SellerType } from '@fittkereso-backend/database';
import {
  SellerCreateService,
  SellerDetailService,
  SellerUpdateService,
} from '@fittkereso-backend/product';
import { SellerSearchParams, SellerSearchService } from '@fittkereso-backend/search';

@Injectable()
export class SellerTools {
  constructor(
    private readonly sellerRepo: SellerRepository,
    private readonly detailService: SellerDetailService,
    private readonly createService: SellerCreateService,
    private readonly updateService: SellerUpdateService,
    private readonly searchService: SellerSearchService,
  ) {}

  // ─── Read Tools ────────────────────────────────────────────────────────────

  @Tool({
    name: 'get_seller',
    description:
      'Get full detail of a single Seller by id — name, slug, type, domains, contact info, verified/active flags, and its ProductSources.',
    parameters: z.object({
      sellerId: z.string().describe('Seller UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getSeller(args: { sellerId: string }): Promise<string> {
    const seller = await this.detailService.getById(args.sellerId);
    return this.formatSeller(seller);
  }

  @Tool({
    name: 'list_sellers',
    description:
      'Search/list sellers (paginated) — filter by name substring, type, verified, active. Use this to find an existing seller before creating a new one (create_seller fails if the name is already taken), or to find a seller id for create_product_source_for_seller.',
    parameters: z.object({
      searchTerm: z.string().optional().describe('Substring match against seller name'),
      types: z.array(z.nativeEnum(SellerType)).optional(),
      verified: z.boolean().optional(),
      active: z.boolean().optional(),
      page: z.number().int().positive().optional().describe('Page number, default 1'),
      pageSize: z.number().int().positive().optional().describe('Results per page, default 50'),
    }),
    annotations: { readOnlyHint: true },
  })
  async listSellers(args: {
    searchTerm?: string;
    types?: SellerType[];
    verified?: boolean;
    active?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<string> {
    const params: SellerSearchParams = args;
    const result = await this.searchService.search(params);

    const L: string[] = [];
    L.push(`# Sellers (${result.totalItems ?? 0} total)`);
    L.push(`Page ${result.page}/${result.totalPages} (pageSize ${result.pageSize})`);
    L.push('');

    for (const seller of result.items ?? []) {
      L.push(`## ${seller.name} (${seller.id})`);
      L.push(
        `- Type: ${seller.type} · Verified: ${seller.verified} · Active: ${seller.active}`,
      );
      if (seller.domains?.length) {
        L.push(`- Domains: ${seller.domains.join(', ')}`);
      }
      L.push('');
    }

    if (!result.items?.length) {
      L.push('_No sellers found._');
    }

    return L.join('\n');
  }

  // ─── Write Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'create_seller',
    description:
      'Create a new Seller. Only takes a name — fails if a seller with that exact name already exists (check with list_sellers first). The created seller starts as type=business, verified=false, active=true; use update_seller afterward to fill in type/domains/contact info and mark it verified.',
    parameters: z.object({
      name: z.string().min(1).describe('Unique seller name'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async createSeller(args: { name: string }): Promise<string> {
    try {
      const seller = await this.createService.createSeller({ name: args.name });
      return `Seller "${seller.name}" created (${seller.id}). Type: business, verified: false, active: true — use update_seller to configure further.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to create seller "${args.name}": ${message}`;
    }
  }

  @Tool({
    name: 'update_seller',
    description:
      'Update an existing Seller — name, type, domains, logoUrl, contactEmail, contactPhone, location, verified, active, maxConcurrent, requestsPerHour. name and type are always required by the underlying update (pass the current values from get_seller if you only want to change one other field); all other fields are only changed when provided. maxConcurrent/requestsPerHour cap the COMBINED usage across all of this seller\'s ProductSources (in addition to each ProductSource\'s own limit) — pass null to clear and rely only on per-source limits.',
    parameters: z.object({
      sellerId: z.string().describe('Seller UUID to update'),
      name: z.string().min(1).describe('Seller name (required by the update — pass the existing name to leave unchanged)'),
      type: z.nativeEnum(SellerType).describe('Seller type (required by the update — pass the existing type to leave unchanged)'),
      domains: z.array(z.string()).optional().describe('Domains this seller owns, e.g. ["example.com"] — replaces existing list'),
      logoUrl: z.string().optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional(),
      location: z.string().optional(),
      verified: z.boolean().optional(),
      active: z.boolean().optional(),
      maxConcurrent: z.number().int().min(1).nullable().optional().describe('Combined max concurrent scrapes across all of this seller\'s ProductSources; null clears it'),
      requestsPerHour: z.number().int().min(1).nullable().optional().describe('Combined requests/hour across all of this seller\'s ProductSources; null clears it'),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  })
  async updateSeller(args: {
    sellerId: string;
    name: string;
    type: SellerType;
    domains?: string[];
    logoUrl?: string;
    contactEmail?: string;
    contactPhone?: string;
    location?: string;
    verified?: boolean;
    active?: boolean;
    maxConcurrent?: number | null;
    requestsPerHour?: number | null;
  }): Promise<string> {
    try {
      const { sellerId, ...dto } = args;
      const seller = await this.updateService.updateSeller(sellerId, dto);
      return `Seller "${seller.name}" (${seller.id}) updated.\n\n${this.formatSeller(seller)}`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to update seller ${args.sellerId}: ${message}`;
    }
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private formatSeller(seller: Seller): string {
    const L: string[] = [];
    L.push(`# Seller: ${seller.name}`);
    L.push(`- **ID**: ${seller.id}`);
    L.push(`- **Slug**: ${seller.slug ?? '_not set_'}`);
    L.push(`- **Type**: ${seller.type}`);
    L.push(`- **Domains**: ${seller.domains?.length ? seller.domains.join(', ') : '_none_'}`);
    L.push(`- **Verified**: ${seller.verified}`);
    L.push(`- **Active**: ${seller.active}`);
    L.push(`- **Contact email**: ${seller.contactEmail ?? '_not set_'}`);
    L.push(`- **Contact phone**: ${seller.contactPhone ?? '_not set_'}`);
    L.push(`- **Location**: ${seller.location ?? '_not set_'}`);
    L.push(`- **Max concurrent (combined)**: ${seller.maxConcurrent ?? '_not set — only per-source limits apply_'}`);
    L.push(`- **Requests per hour (combined)**: ${seller.requestsPerHour ?? '_not set — only per-source limits apply_'}`);

    if (seller.productSources?.length) {
      L.push('');
      L.push('## Product Sources');
      for (const source of seller.productSources) {
        L.push(`- ${source.name} (${source.id})`);
      }
    }

    return L.join('\n');
  }
}
