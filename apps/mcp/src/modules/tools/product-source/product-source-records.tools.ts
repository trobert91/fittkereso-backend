import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ProductSourceRecordRepository,
  ProductSourceRecordRow,
} from '@fittkereso-backend/database';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// Read-only listing tooling: a source's listings (ProductSourceRecords), which
// get_product_detail only shows product by product.
@Injectable()
export class ProductSourceRecordsTools {
  constructor(private readonly sourceRecordRepo: ProductSourceRecordRepository) {}

  @Tool({
    name: 'list_product_source_records',
    description:
      "List listings (ProductSourceRecords): one per (source, URL), each with what that source said about the item. Filter by source or by seller (one of the two is required), by whether the listing sits on a product, and by text. A listing is unattached (attached: false) when its source does not identify products and its seller's identifying source has no offer for it yet: it waits, and attaches once that offer is written. So the unattached listings of a seller's contributing source show what its identifying source lacks. Paged, newest sighting first.",
    parameters: z.object({
      productSourceId: z.string().optional().describe('ProductSource UUID'),
      sellerId: z.string().optional().describe('Seller UUID: every source of the seller'),
      attached: z
        .boolean()
        .optional()
        .describe('true: only listings on a product · false: only unattached ones · omitted: both'),
      search: z
        .string()
        .optional()
        .describe('Case-insensitive text matched against the URL, the externalIds and the title'),
      page: z.number().int().positive().optional().describe('Page number, default 1'),
      pageSize: z
        .number()
        .int()
        .positive()
        .max(MAX_PAGE_SIZE)
        .optional()
        .describe(`Results per page, default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}`),
    }),
    annotations: { readOnlyHint: true },
  })
  async listProductSourceRecords(args: {
    productSourceId?: string;
    sellerId?: string;
    attached?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<string> {
    if (!args.productSourceId && !args.sellerId) {
      return 'Pass productSourceId or sellerId.';
    }
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = await this.sourceRecordRepo.searchRecords({
      productSourceId: args.productSourceId,
      sellerId: args.sellerId,
      attached: args.attached,
      search: args.search,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const filters = [
      args.productSourceId && `source ${args.productSourceId}`,
      args.sellerId && `seller ${args.sellerId}`,
      args.attached === true && 'attached',
      args.attached === false && 'unattached',
      args.search && `matching "${args.search}"`,
    ].filter(Boolean);
    const L: string[] = [];
    L.push(`# Listings (${total} total): ${filters.join(' · ')}`);
    L.push(`Page ${page}/${Math.max(1, Math.ceil(total / pageSize))} (pageSize ${pageSize})`);
    L.push('');
    if (items.length === 0) {
      L.push('_No listings match._');
      return L.join('\n');
    }

    L.push('| Source | URL | externalId | Title | Price | Product | Last seen |');
    L.push('|---|---|---|---|---|---|---|');
    for (const row of items) {
      L.push(
        `| ${[
          row.sourceName,
          row.url ?? '—',
          externalIdsOf(row),
          row.title ?? '—',
          row.price ?? '—',
          row.productId ? `${row.productName ?? ''} (${row.productId})` : '— (unattached)',
          new Date(row.seenAt).toISOString(),
        ]
          .map((cell) => String(cell).replace(/\|/g, '\\|'))
          .join(' | ')} |`,
      );
    }
    return L.join('\n');
  }
}

/** The ids its offers are stored under, else the listing's own. */
function externalIdsOf(row: ProductSourceRecordRow): string {
  if (row.offerExternalIds.length > 0) return row.offerExternalIds.join(', ');
  return row.externalId ?? '—';
}
