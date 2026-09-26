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
  ProductCandidate,
  ProductCandidateFinderService,
  ProductMatchQuery,
  ProductMatchQueryService,
} from '@fittkereso-backend/product-identity';
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
      'Explains product matching. Pass productId to see a stored product\'s duplicate candidates, or sourceRecordId to replay that listing as if it were scraped now (the brand is the attached product\'s). Returns the name key, every recalled candidate with trigram and Levenshtein similarity, base score, failed gates with both values, and final score, plus what would happen: the duplicate pairs (score 70+) for a product, or the listing match outcome (attach / ask the LLM / create) for a listing. Read-only; never calls the LLM.',
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
    if (!scraped?.model && !scraped?.displayName) {
      return `Source record ${sourceRecordId} has no scraped name to match on.`;
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

    const L: string[] = [];
    L.push(`# Product candidates for ${title}`);
    L.push('');
    L.push(
      `Name key: \`${query.nameKey}\` · brand ${query.brandName} · category ${query.categorySlug}`,
    );
    L.push('');

    if (candidates.length === 0) {
      L.push('Recall found no candidates.');
    } else {
      L.push(
        '| # | Product | Matched on | Trigram | Levenshtein | Alignment | Base | Failed gates | Score |',
      );
      L.push(
        '|---|---------|------------|---------|-------------|-----------|------|--------------|-------|',
      );
      candidates.forEach((candidate, index) => {
        const { trigram, levenshtein, alignment } = candidate.nameSimilarity;
        const align = alignment === undefined ? '—' : alignment.toFixed(2);
        L.push(
          `| ${index + 1} | ${candidate.displayName} (${candidate.productId}) | ${candidate.matchedOn}: \`${candidate.matchedValue}\` | ${trigram.toFixed(2)} | ${levenshtein.toFixed(2)} | ${align} | ${baseScore(candidate.nameSimilarity)} | ${this.formatGates(candidate.failedGates)} | ${candidate.score} |`,
        );
      });
    }

    L.push('');
    L.push(
      kind === 'listing'
        ? this.describeListingMatch(candidates)
        : this.describePairs(candidates),
    );
    return L.join('\n');
  }

  private describeListingMatch(candidates: ProductCandidate[]): string {
    const outcome = decideListingMatch(candidates);
    if (outcome.kind === 'attach') {
      return `Listing match: attach to ${outcome.candidate.displayName} (${outcome.candidate.productId}).`;
    }
    if (outcome.kind === 'ask_llm') {
      return `Listing match: ask the LLM about ${outcome.candidates.length} candidate(s): ${outcome.candidates.map((candidate) => candidate.productId).join(', ')}.`;
    }
    return `Listing match: create a new product (no candidate scores ${NEAR_MISS_SCORE}+).`;
  }

  private describePairs(candidates: ProductCandidate[]): string {
    const paired = candidates.filter(
      (candidate) => candidate.score >= NEAR_MISS_SCORE,
    );
    if (paired.length === 0) {
      return `Duplicate detection: no pair (no candidate scores ${NEAR_MISS_SCORE}+).`;
    }
    return `Duplicate detection: pairs with ${paired.map((candidate) => candidate.productId).join(', ')}.`;
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
