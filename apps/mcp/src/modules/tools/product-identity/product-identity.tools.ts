import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { isArray } from 'lodash';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import {
  baseScore,
  decideListingMatch,
  FailedGate,
  NEAR_MISS_SCORE,
  pairScoreOf,
  ProductCandidate,
  ProductCandidateFinderService,
  ProductMatchQuery,
  ProductMatchQueryService,
} from '@fittkereso-backend/product-identity';
import type { ListingMatchMode } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';

interface MatchSubject {
  kind: 'product' | 'listing';
  title: string;
  query: ProductMatchQuery;
}

@Injectable()
export class ProductIdentityTools {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly queryService: ProductMatchQueryService,
    private readonly finder: ProductCandidateFinderService,
  ) {}

  @Tool({
    name: 'find_product_candidates',
    description:
      'Explains product matching. Pass productId to see a stored product\'s duplicate candidates, or sourceRecordId to replay that listing as if it were scraped now (the brand is the attached product\'s). Returns the name key and matcherModel key, every recalled candidate (by name, alias or matcherModel key) with trigram and Levenshtein similarity, base score, failed gates with both values, final score, whether it shares the matcherModel key and its key score (spec gates alone), plus what would happen: the duplicate pairs (70+ by name, or by key score when the keys match) for a product, or the listing match outcome (attach / ask the LLM / create) under both the score rule and the key rule for a listing, marking the one the category acts on. Read-only; never calls the LLM.',
    parameters: z.object({
      productId: z
        .string()
        .optional()
        .describe('Product UUID: find its duplicate candidates'),
      sourceRecordId: z
        .string()
        .optional()
        .describe('ProductSourceRecord UUID: replay that listing'),
    }),
    annotations: { readOnlyHint: true },
  })
  async findProductCandidates(args: {
    productId?: string;
    sourceRecordId?: string;
  }): Promise<string> {
    const { productId, sourceRecordId } = args;
    try {
      if (productId && !sourceRecordId) {
        return this.explain(await this.productSubject(productId));
      }
      if (sourceRecordId && !productId) {
        return this.explain(await this.listingSubject(sourceRecordId));
      }
      return 'Pass exactly one of productId or sourceRecordId.';
    } catch (error: unknown) {
      return `Could not build a match query: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async productSubject(
    productId: string,
  ): Promise<MatchSubject | string> {
    const product = await this.productRepo.findOne({
      where: { id: productId },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
      ],
    });
    if (!product) return `Product ${productId} not found.`;

    return {
      kind: 'product',
      title: `${product.displayName} (${product.id})`,
      query: this.queryService.ofProduct(product),
    };
  }

  private async listingSubject(
    sourceRecordId: string,
  ): Promise<MatchSubject | string> {
    const model = nameOf<ProductSourceRecord>('model');
    const record = await this.sourceRecordRepo.findOne({
      where: { id: sourceRecordId },
      relations: [
        model,
        `${model}.${nameOf<ProductModel>('brand')}`,
        `${model}.${nameOf<ProductModel>('productCategory')}`,
      ],
    });
    if (!record) return `Source record ${sourceRecordId} not found.`;

    const product = record.model;
    const scraped = record.scrapedProduct;
    if (!product?.brand || !product.productCategory) {
      return `Source record ${sourceRecordId} has no product with a brand and category.`;
    }
    // An unidentified listing is keyed on its title, as the scraper keys it.
    if (!scraped?.model && !scraped?.displayName && !scraped?.originalName) {
      return `Source record ${sourceRecordId} has no scraped name or title to match on.`;
    }

    const { productCategory } = product;
    const category = scraped.category ?? {
      id: productCategory.id,
      slug: productCategory.slug,
      name: productCategory.name,
    };

    return {
      kind: 'listing',
      title: `listing ${record.id}, attached to ${product.displayName} (${product.id})`,
      query: this.queryService.ofListing(
        { ...scraped, category } as ScrapedProduct,
        product.brand,
      ),
    };
  }

  private async explain(subject: MatchSubject | string): Promise<string> {
    if (typeof subject === 'string') return subject;

    const { kind, title, query } = subject;
    const candidates = await this.finder.findCandidates(query);
    const keys = query.matcherModelKeys;
    const keyText =
      keys === undefined
        ? "its listings' (the finder loads them)"
        : keys.length
          ? keys.map((key) => `\`${key}\``).join(', ')
          : 'none';

    const L: string[] = [];
    L.push(`# Product candidates for ${title}`);
    L.push('');
    L.push(
      `Name key: \`${query.nameKey}\` · matcherModel key: ${keyText} · brand ${query.brandName} · category ${query.categorySlug}`,
    );
    L.push('');

    if (candidates.length === 0) {
      L.push('Recall found no candidates.');
    } else {
      L.push(
        '| # | Product | Matched on | Trigram | Levenshtein | Alignment | Base | Failed gates | Score | Key | Key score |',
      );
      L.push(
        '|---|---------|------------|---------|-------------|-----------|------|--------------|-------|-----|-----------|',
      );
      candidates.forEach((candidate, index) => {
        const { trigram, levenshtein, alignment } = candidate.nameSimilarity;
        const align = alignment === undefined ? '—' : alignment.toFixed(2);
        L.push(
          `| ${index + 1} | ${candidate.displayName} (${candidate.productId}) | ${candidate.matchedOn}: \`${candidate.matchedValue}\` | ${trigram.toFixed(2)} | ${levenshtein.toFixed(2)} | ${align} | ${baseScore(candidate.nameSimilarity)} | ${this.formatGates(candidate.failedGates)} | ${candidate.score} | ${this.formatKeyMatch(candidate)} | ${candidate.keyScore} |`,
        );
      });
    }

    L.push('');
    L.push(
      kind === 'listing'
        ? this.describeListingMatch(candidates, query)
        : this.describePairs(candidates),
    );
    return L.join('\n');
  }

  /** Both rules; the category's `matcherModel.required` picks the one that acts. */
  private describeListingMatch(
    candidates: ProductCandidate[],
    query: ProductMatchQuery,
  ): string {
    const [key] = query.matcherModelKeys ?? [];
    const acting: ListingMatchMode =
      key && this.queryService.requiresMatcherModel(query.categorySlug)
        ? 'key'
        : 'score';
    const lines = [this.describeRule('score', candidates, acting)];
    lines.push(
      key
        ? this.describeRule('key', candidates, acting, key.split(' ').length < 2)
        : '- Key rule: the listing has no matcherModel key, so the score rule decides.',
    );
    return ['Listing match:', ...lines].join('\n');
  }

  private describeRule(
    mode: ListingMatchMode,
    candidates: ProductCandidate[],
    acting: ListingMatchMode,
    shortKey = false,
  ): string {
    const rule = mode === 'key' ? 'Key rule' : 'Score rule';
    const label = `- ${rule} (${mode === acting ? 'acts' : 'shadow'}):`;
    const outcome = decideListingMatch(candidates, { mode, shortKey });
    if (outcome.kind === 'attach') {
      return `${label} attach to ${outcome.candidate.displayName} (${outcome.candidate.productId}).`;
    }
    if (outcome.kind === 'ask_llm') {
      return `${label} ask the LLM about ${outcome.candidates.length} candidate(s): ${outcome.candidates.map((candidate) => candidate.productId).join(', ')}.`;
    }
    return `${label} create a new product.`;
  }

  private describePairs(candidates: ProductCandidate[]): string {
    const paired = candidates.filter(
      (candidate) => pairScoreOf(candidate) >= NEAR_MISS_SCORE,
    );
    if (paired.length === 0) {
      return `Duplicate detection: no pair (no candidate scores ${NEAR_MISS_SCORE}+ by name, or by key score with the same key).`;
    }
    return `Duplicate detection: pairs with ${paired.map((candidate) => candidate.productId).join(', ')}.`;
  }

  private formatKeyMatch(candidate: ProductCandidate): string {
    if (candidate.matcherModelMatch === undefined) return '—';
    return candidate.matcherModelMatch ? 'same' : 'other';
  }

  private formatGates(gates: FailedGate[]): string {
    if (gates.length === 0) return '—';
    return gates
      .map(
        (gate) =>
          `−${gate.severity} ${gate.spec ?? gate.gate}: ${this.formatValue(gate.queryValue)} ≠ ${this.formatValue(gate.candidateValue)}`,
      )
      .join('; ');
  }

  private formatValue(value: FailedGate['queryValue']): string {
    if (value === null) return 'missing';
    return isArray(value) ? value.join(' ') : String(value);
  }
}
