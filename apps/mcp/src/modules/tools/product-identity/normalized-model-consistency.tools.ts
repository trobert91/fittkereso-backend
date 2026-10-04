import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { countBy, groupBy, isNil, keyBy, take, uniq } from 'lodash';
import {
  IdentifyingListingRow,
  OfferRepository,
  ProductSourceRecordRepository,
  RecordIdentifierPair,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';

interface KeyedListing extends IdentifyingListingRow {
  text?: string;
  key?: string;
}

interface PairVerdict {
  a: KeyedListing;
  b: KeyedListing;
  label: string;
}

/** How many pairs agreed, and the ones that didn't (or couldn't be keyed). */
interface PairTally {
  equal: number;
  unequal: PairVerdict[];
  unkeyed: number;
}

/**
 * Measures whether listings' normalizedModel keys say "same model" exactly
 * when they should. Read-only.
 */
@Injectable()
export class NormalizedModelConsistencyTools {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
    private readonly queryService: ProductMatchQueryService,
  ) {}

  @Tool({
    name: 'normalized_model_consistency',
    description:
      "Measures the normalizedModel keys built from listings' model names against ground truth, over every listing of a product-identifying source in a category. Same model: listings whose offers share a GTIN, or an MPN within one brand — reported cross-shop and same-shop apart, as the share whose keys are equal (target ≥ 95%). Different models: the pairs you pass (record ids), as the share whose keys differ (target 100%). Also lists products whose listings disagree on the key — candidates for a wrong merge. Keys are built from the stored models, so no LLM is called. Read-only.",
    parameters: z.object({
      categorySlug: z.string().default('ebikes'),
      differentPairs: z
        .array(
          z.object({
            a: z.string().describe('ProductSourceRecord id'),
            b: z.string().describe('ProductSourceRecord id'),
            note: z.string().optional(),
          }),
        )
        .optional()
        .describe('Listing pairs known to be different models'),
      samples: z.number().int().min(0).max(100).default(15),
    }),
    annotations: { readOnlyHint: true },
  })
  async measure(args: {
    categorySlug: string;
    differentPairs?: { a: string; b: string; note?: string }[];
    samples: number;
  }): Promise<string> {
    const { categorySlug, differentPairs = [], samples } = args;
    try {
      const listings = (
        await this.sourceRecordRepo.findIdentifyingListingsInCategory(categorySlug)
      ).map((row) => this.keyed(row));
      const byId = keyBy(listings, (listing) => listing.id);

      const sharing = (await this.offerRepo.findRecordPairsSharingIdentifier()).filter(
        (pair) => byId[pair.a] && byId[pair.b],
      );
      const sameModel = groupBy(sharing, (pair) =>
        byId[pair.a].sellerId === byId[pair.b].sellerId ? 'same-shop' : 'cross-shop',
      );

      const L: string[] = [
        `# normalizedModel consistency — ${categorySlug}`,
        '',
        this.coverageLine(listings),
        '',
        '## Same model (should be equal)',
      ];
      for (const scope of ['cross-shop', 'same-shop']) {
        const pairs = sameModel[scope] ?? [];
        const tally = this.tally(
          pairs.map((pair) => this.verdictOf(pair, byId)),
          (verdict) => verdict.a.key === verdict.b.key,
        );
        L.push(this.tallyLine(scope, pairs.length, tally, 'equal'));
        L.push(...this.sampleLines(tally.unequal, samples));
      }

      L.push('', '## Different models (should differ)');
      if (differentPairs.length === 0) {
        L.push('- No pairs given.');
      } else {
        const verdicts = differentPairs
          .filter((pair) => byId[pair.a] && byId[pair.b])
          .map((pair) => ({
            a: byId[pair.a],
            b: byId[pair.b],
            label: pair.note ?? 'given',
          }));
        const missing = differentPairs.length - verdicts.length;
        const tally = this.tally(verdicts, (verdict) => verdict.a.key !== verdict.b.key);
        L.push(this.tallyLine('given', verdicts.length, tally, 'different'));
        if (missing) L.push(`- ${missing} pair(s) name a record outside this category's identifying listings.`);
        L.push(...this.sampleLines(tally.unequal, samples));
      }

      L.push('', '## Products whose listings disagree on the key');
      L.push(...this.conflictLines(listings, samples));
      return L.join('\n');
    } catch (error) {
      return `Error measuring normalizedModel consistency: ${(error as Error).message}`;
    }
  }

  private keyed(row: IdentifyingListingRow): KeyedListing {
    const listing = row.listing as ScrapedProduct;
    return {
      ...row,
      text: listing.model,
      key: listing.category ? this.queryService.normalizedModelOf(listing) : undefined,
    };
  }

  private verdictOf(
    pair: RecordIdentifierPair,
    byId: Record<string, KeyedListing>,
  ): PairVerdict {
    return { a: byId[pair.a], b: byId[pair.b], label: `${pair.via} ${pair.value}` };
  }

  /** `holds` counts a keyed pair as right; pairs missing a key are only counted. */
  private tally(verdicts: PairVerdict[], holds: (verdict: PairVerdict) => boolean): PairTally {
    const keyed = verdicts.filter(
      (verdict) => !isNil(verdict.a.key) && !isNil(verdict.b.key),
    );
    return {
      equal: keyed.filter(holds).length,
      unequal: keyed.filter((verdict) => !holds(verdict)),
      unkeyed: verdicts.length - keyed.length,
    };
  }

  private coverageLine(listings: KeyedListing[]): string {
    const keyed = listings.filter((listing) => listing.key).length;
    const bySource = countBy(
      listings.filter((listing) => !listing.key),
      (listing) => listing.sourceName,
    );
    const unkeyed = Object.entries(bySource)
      .map(([source, count]) => `${source} ${count}`)
      .join(', ');
    return `${listings.length} listings, ${keyed} with a key${unkeyed ? ` (none: ${unkeyed})` : ''}.`;
  }

  private tallyLine(scope: string, total: number, tally: PairTally, word: string): string {
    const keyed = tally.equal + tally.unequal.length;
    const share = keyed ? ((100 * tally.equal) / keyed).toFixed(1) : '–';
    return `- **${scope}**: ${tally.equal} of ${keyed} keyed pairs ${word} (${share}%)${
      tally.unkeyed ? `; ${tally.unkeyed} of ${total} pairs lack a key` : ''
    }`;
  }

  private sampleLines(verdicts: PairVerdict[], samples: number): string[] {
    return take(verdicts, samples).map(
      ({ a, b, label }) =>
        `  - ${label}: ${a.sourceName} "${a.text}" → \`${a.key}\` · ${b.sourceName} "${b.text}" → \`${b.key}\` (${a.id} / ${b.id})`,
    );
  }

  private conflictLines(listings: KeyedListing[], samples: number): string[] {
    const onProducts = groupBy(
      listings.filter((listing) => listing.modelId && listing.key),
      (listing) => listing.modelId,
    );
    const conflicts = Object.entries(onProducts).filter(
      ([, members]) => uniq(members.map((member) => member.key)).length > 1,
    );
    const lines = [
      `- ${conflicts.length} of ${Object.keys(onProducts).length} products with keyed listings hold more than one key.`,
    ];
    for (const [modelId, members] of take(conflicts, samples)) {
      const keys = Object.entries(groupBy(members, (member) => member.key)).map(
        ([key, group]) =>
          `\`${key}\` (${uniq(group.map((member) => member.sourceName)).join(', ')}, ${group.length})`,
      );
      lines.push(`  - ${modelId}: ${keys.join(' · ')}`);
    }
    return lines;
  }
}
