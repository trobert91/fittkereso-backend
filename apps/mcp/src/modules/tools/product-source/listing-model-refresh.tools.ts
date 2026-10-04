import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  ListingModelRefreshService,
  ListingModelRefreshSummary,
} from '@fittkereso-backend/product-scraper';

/**
 * Identity extraction cost per listing, measured on the 2026-10-02 wave-1
 * test imports ($0.00016–0.00038): a ceiling for the estimate, not a bill.
 */
const COST_PER_LISTING = 0.0004;

@Injectable()
export class ListingModelRefreshTools {
  constructor(private readonly refresher: ListingModelRefreshService) {}

  @Tool({
    name: 'refresh_listing_models',
    description:
      "Brings stored listings in line with the current model rule, without re-importing them, in two passes. First, every listing's record columns (resolved brand, model, title, normalizedModel) are filled from its stored listing — no LLM. Then each identifying listing whose model was asked under an older contract (the category's left-out specs, examples or prompt version) goes through the identity extraction once more; only its model, contract and key are written — no spec or offer changes — and its product is named again (mergeSources, under the product's lock). Skips listings already under the current contract, listings stored without a raw title, and sources with the identity extraction off. Costs one LLM call per listing asked (about $0.0003); `limit` counts those calls. dryRun (default) only counts.",
    parameters: z.object({
      dryRun: z.boolean().default(true).describe('Count only; nothing called or written'),
      sourceId: z.string().optional().describe('Only this ProductSource'),
      categorySlug: z.string().optional(),
      recordIds: z
        .array(z.string().uuid())
        .min(1)
        .max(5000)
        .optional()
        .describe('Only these listings (ProductSourceRecord ids), in both passes'),
      limit: z.number().int().min(1).max(5000).default(200).describe('At most this many listings asked'),
      concurrency: z.number().int().min(1).max(8).default(4),
    }),
  })
  async run(args: {
    dryRun: boolean;
    sourceId?: string;
    categorySlug?: string;
    recordIds?: string[];
    limit: number;
    concurrency: number;
  }): Promise<string> {
    try {
      const summary = await this.refresher.refresh(args);
      return this.format(args.dryRun, summary);
    } catch (error) {
      return `Error refreshing listing models: ${(error as Error).message}`;
    }
  }

  private format(dryRun: boolean, summary: ListingModelRefreshSummary): string {
    const L = [
      `# Listing model refresh${dryRun ? ' — dry run' : ''}`,
      '',
      '## Record columns (no LLM)',
      `- **read**: ${summary.columns.read} listings`,
      `- **${dryRun ? 'would change' : 'changed'}**: ${summary.columns.changed}`,
      '',
      '## Models asked again',
      `- **read**: ${summary.read} identifying listings with a stored model`,
      `- **already under the current contract**: ${summary.current}`,
      `- **no raw title stored** (can't be asked): ${summary.noTitle}`,
      `- **identity extraction off**: ${summary.identityOff}`,
      `- **${dryRun ? 'would ask' : 'asked'}**: ${summary.asked} (≈ $${(summary.asked * COST_PER_LISTING).toFixed(2)} at most)`,
    ];
    if (!dryRun) {
      L.push(`- **renamed**: ${summary.written}`);
      L.push(`- **failed** (stored model kept, asked again next run or import): ${summary.failed}`);
      L.push(`- **products named again**: ${summary.productsMerged}`);
    }
    if (summary.more) L.push('- **more left**: the limit was reached; run again.');
    return L.join('\n');
  }
}
