import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  FeedCheckService,
  LISTING_SAMPLE_MAX,
  ListingSampleService,
  PAGE_SAMPLE_MAX,
  PageSampleService,
  ShopReviewSummaryService,
} from '@fittkereso-backend/product-scraper';
import {
  formatFeedCheck,
  formatListingSample,
  formatPageSample,
  formatShopReviewSummary,
} from './shop-review.format';

const DEFAULT_SLICE = 20;
const DEFAULT_PAGES = 5;

// Read-only tooling for reviewing what a seller's sources import against what
// the shop publishes: the data the review-webshop and onboard-webshop skills
// read. Nothing here writes or queues anything, and nothing calls an LLM.
@Injectable()
export class ShopReviewTools {
  constructor(
    private readonly summaryService: ShopReviewSummaryService,
    private readonly feedCheckService: FeedCheckService,
    private readonly listingSampleService: ListingSampleService,
    private readonly pageSampleService: PageSampleService,
  ) {}

  @Tool({
    name: 'sample_shop_pages',
    description:
      "Reads a slice of a source's listings' product pages NOW and shows each page's visible text beside what the source's detailPage pipelines extracted from the same HTML (rows, brand, model, ids, images, offers): text the extraction does not hold is what the selectors miss. For a scraping source, or a feed source with a detailPage (its listings' product pages). Same order as sample_shop_listings. COSTS one fetch per page, through Zyte (paid) unless the page's fetch mode is direct; at most 10 pages per call. No spec mapping, no LLM call, nothing written.",
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      categorySlug: z.string().optional().describe('Only listings imported into this category'),
      offset: z.number().int().min(0).optional().describe('Position of the first listing, default 0'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(PAGE_SAMPLE_MAX)
        .optional()
        .describe(`Pages to read, default ${DEFAULT_PAGES}, at most ${PAGE_SAMPLE_MAX}`),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  })
  async sampleShopPages(args: {
    productSourceId: string;
    categorySlug?: string;
    offset?: number;
    limit?: number;
  }): Promise<string> {
    const [source] = await this.summaryService.resolveSources({ productSourceId: args.productSourceId });
    if (!source) return `ProductSource ${args.productSourceId} not found.`;
    const limit = args.limit ?? DEFAULT_PAGES;
    const sample = await this.pageSampleService.sample({
      source,
      categorySlug: args.categorySlug,
      offset: args.offset ?? 0,
      limit,
    });
    return formatPageSample(sample, limit);
  }

  @Tool({
    name: 'get_shop_review_summary',
    description:
      "Shop-wide aggregates of what a seller's sources imported, for finding gaps: per source and category, listing counts (attached, specValid=false, identity_failed, page read/failed); for every key of the category schema, the share of listings that have it from the deterministic specMapping, after the LLM pass, in offer entries, and on their products (keys never filled, and LLM-only keys a mapping could fill, listed first); saved-field coverage (images, description, aliases, siblings, and each offer field as value / mapped-but-null / not mapped); the spec-row labels no specMapping reads, with counts and examples; specMapping labels no stored row carries; and, for feed sources, the columns of the newest stored feed rows no mapping target, filter or extraSpecRows reads. Database reads only: free, no fetch, no LLM. Pass sellerId for every source of a seller, or productSourceId for one.",
    parameters: z.object({
      sellerId: z.string().optional().describe('Seller UUID: every source of the seller'),
      productSourceId: z.string().optional().describe('ProductSource UUID: one source'),
      categorySlug: z.string().optional().describe('Narrow every section to one category, e.g. "ebikes"'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getShopReviewSummary(args: {
    sellerId?: string;
    productSourceId?: string;
    categorySlug?: string;
  }): Promise<string> {
    if (!args.sellerId && !args.productSourceId) return 'Pass sellerId or productSourceId.';
    const summaries = await this.summaryService.summarize(args);
    if (summaries.length === 0) return 'No product source found for that seller or id.';
    return formatShopReviewSummary(summaries, args.categorySlug);
  }

  @Tool({
    name: 'check_product_source_feed',
    description:
      "Is a feed source's feed still giving us what it did? Downloads the feed ONCE (direct for a direct source; through Zyte, one paid request, for a proxied one) and keeps it for 60 minutes, so sample_shop_listings slices read each listing's raw row from it without downloading again. and runs only the free category gate on every row: reachable, size and timing, rows by gate outcome (eligible per category, or the skip reason), repeated listing ids, eligible rows with no listing yet (new), listings no eligible row names any more (delisted), columns that appeared or vanished against the newest stored feed rows, and every column of the eligible rows with its fill rate and the config part that reads it. Also the source's last import run and its import tasks by status. No LLM call, nothing written or queued. For a scraping source only the import state is shown: nothing is fetched.",
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async checkProductSourceFeed(args: { productSourceId: string }): Promise<string> {
    const [source] = await this.summaryService.resolveSources({ productSourceId: args.productSourceId });
    if (!source) return `ProductSource ${args.productSourceId} not found.`;
    return formatFeedCheck(await this.feedCheckService.check(source));
  }

  @Tool({
    name: 'sample_shop_listings',
    description:
      "One slice of a source's stored listings, each laid out next to the raw data it came from, for comparing what the shop published with what we saved: the listing's specs marked deterministic / LLM-filled / LLM-changed, what its product has from other sellers and which schema keys it lacks, every raw spec row marked mapped / identity-only / unread, for a feed source the stored feed row's columns no target reads, a description excerpt, the image count and every offer entry (price, old price, availability, condition, GTIN, MPN, offer specs). Ordered by the product's publicId, which is random but stable: evenly spaced offsets give a random sample, the same offset gives the same listings, and slices never overlap. The header gives the total. Database reads only (free, no LLM), unless feedRows is \"live\" and no feed snapshot is kept.",
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      categorySlug: z.string().optional().describe('Only listings imported into this category'),
      offset: z.number().int().min(0).optional().describe('Position of the first listing, default 0'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(LISTING_SAMPLE_MAX)
        .optional()
        .describe(`Listings in the slice, default ${DEFAULT_SLICE}, at most ${LISTING_SAMPLE_MAX}`),
      includeUnattached: z
        .boolean()
        .optional()
        .describe('Also include listings that wait without a product (after the attached ones)'),
      feedRows: z
        .enum(['auto', 'live', 'none'])
        .optional()
        .describe(
          'Feed sources: where each listing\'s raw feed row comes from. "auto" (default): the row its last import stored, else the feed snapshot a check_product_source_feed call kept (60 minutes); never downloads. "live": the kept snapshot, downloading the feed once if there is none (through Zyte for a proxied source). "none": no feed rows.',
        ),
    }),
    annotations: { readOnlyHint: true },
  })
  async sampleShopListings(args: {
    productSourceId: string;
    categorySlug?: string;
    offset?: number;
    limit?: number;
    includeUnattached?: boolean;
    feedRows?: 'auto' | 'live' | 'none';
  }): Promise<string> {
    const [source] = await this.summaryService.resolveSources({ productSourceId: args.productSourceId });
    if (!source) return `ProductSource ${args.productSourceId} not found.`;
    const limit = args.limit ?? DEFAULT_SLICE;
    const sample = await this.listingSampleService.sample({
      source,
      categorySlug: args.categorySlug,
      offset: args.offset ?? 0,
      limit,
      includeUnattached: args.includeUnattached,
      feedRows: args.feedRows,
    });
    return formatListingSample(sample, limit);
  }
}
