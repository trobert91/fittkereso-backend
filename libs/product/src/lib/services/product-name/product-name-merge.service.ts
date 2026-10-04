import { Injectable } from '@nestjs/common';
import { ProductAlias, ProductAliasSource, ProductModel, ProductSource, ProductSourceRecord } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { orderBy } from 'lodash';
import { productDisplayName } from '@fittkereso-backend/utils';
import { BrandResolutionService } from '../brand/brand-resolution.service';
import { getLatestSourcePerSource } from '../product-spec/get-latest-source-per-source';
import { ProductNormalizerService } from '../product-normalizer.service';
import { EntityManager } from 'typeorm';
import { ProductAliasRepository } from '@fittkereso-backend/database';

type NameValue = string | number;

interface NameCandidate {
  value: NameValue;
  priority: number;
  lastUpdated: Date;
}

interface ValueGroup {
  normalized: string;
  candidates: NameCandidate[];
}

/**
 * Recomputes ProductModel's name fields (brand/model/displayName/aliases,
 * plus the normalizedName key built from them) from its identifying
 * ProductSourceRecords — the name-field counterpart to
 * ProductSpecMergeService, called from ProductMergeService.mergeSources
 * alongside the spec merge.
 *
 * The brand is voted on: corroboration, then recency, then priority, over
 * each source's latest listing. The model is not: the product shows the model
 * of its highest-priority source (namingRecordOf), so a lower-priority shop
 * joining it never renames it.
 */
@Injectable()
export class ProductNameMergeService {
  private readonly logger = new CustomLogger(ProductNameMergeService.name);

  constructor(
    private readonly brandResolution: BrandResolutionService,
    private readonly aliasRepo: ProductAliasRepository,
    private readonly productNormalizer: ProductNormalizerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /** `records`: the product's records of sources that identify products. */
  public async mergeNames(
    model: ProductModel,
    records: ProductSourceRecord[],
    categorySlug: string | undefined,
    manager?: EntityManager,
  ): Promise<void> {
    const latestPerSource = getLatestSourcePerSource(records);
    const brandWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.brand,
    );
    const naming = this.namingRecordOf(records);

    if (brandWinner !== undefined) {
      const resolved = await this.brandResolution.resolve(
        String(brandWinner),
        naming?.scrapedProduct?.originalName,
      );
      if (resolved?.entity) {
        model.brand = resolved.entity;
      }
    }
    const name = naming ? this.nameOf(naming, model.brand?.name) : undefined;
    if (name) {
      model.model = name;
      model.displayName = productDisplayName(model.brand?.name, name);
    }

    // Before the alias merge, which skips aliases equal to the key.
    this.recomputeNormalizedName(model, categorySlug);
    await this.mergeAliases(model, latestPerSource, manager);
  }

  // ─── The model: the highest-priority source's ─────────────────────────

  /**
   * The record the product is named after: of the listings the identity
   * extraction named, the highest-priority source's, its oldest on a tie —
   * stable, so two shops of one priority, or one shop's size listings, don't
   * take turns naming it. When no listing was named (the call failed, or is
   * off for those sources), the same pick among all of them, named by its
   * title.
   */
  private namingRecordOf(records: ProductSourceRecord[]): ProductSourceRecord | undefined {
    const ranked = orderBy(
      records,
      [
        (record) => this.getSourcePriority(record.source),
        // A record not saved yet is this import's: the newest.
        (record) => record.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
      ],
      ['desc', 'asc'],
    );
    return (
      ranked.find((record) => !!record.scrapedProduct?.model) ??
      ranked.find((record) => !!record.scrapedProduct?.originalName)
    );
  }

  /** The record's model, else its title without a leading brand. */
  private nameOf(record: ProductSourceRecord, brandName: string | undefined): string | undefined {
    const scraped = record.scrapedProduct;
    if (scraped?.model) return scraped.model;
    const title = scraped?.originalName?.trim();
    if (!title) return undefined;

    const brand = [brandName, scraped?.brand].find(
      (name) => !!name && title.toLowerCase().startsWith(`${name.toLowerCase()} `),
    );
    return brand ? title.slice(brand.length).trim() : title;
  }

  // ─── Per-field resolution (corroboration, then recency/priority) ───────

  private resolveField(
    sources: ProductSourceRecord[],
    extract: (record: ProductSourceRecord) => NameValue | undefined,
  ): NameValue | undefined {
    const candidates = this.buildCandidates(sources, extract);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0].value;

    const groups = this.groupByValue(candidates);
    const maxCount = Math.max(...groups.map((g) => g.candidates.length));
    const tied = groups.filter((g) => g.candidates.length === maxCount);

    const representatives = tied.map((g) => this.pickRepresentative(g));
    return orderBy(representatives, ['lastUpdated', 'priority'], ['desc', 'desc'])[0]
      .value;
  }

  private buildCandidates(
    sources: ProductSourceRecord[],
    extract: (record: ProductSourceRecord) => NameValue | undefined,
  ): NameCandidate[] {
    const candidates: NameCandidate[] = [];
    for (const record of sources) {
      const value = extract(record);
      if (value === undefined || value === null || value === '') continue;
      candidates.push({
        value,
        priority: this.getSourcePriority(record.source),
        lastUpdated: record.lastUpdated,
      });
    }
    return candidates;
  }

  private getSourcePriority(source: ProductSource | null | undefined): number {
    return source?.priority ?? 0;
  }

  private groupByValue(candidates: NameCandidate[]): ValueGroup[] {
    const byNormalized = new Map<string, NameCandidate[]>();
    for (const candidate of candidates) {
      const normalized = this.normalize(candidate.value);
      const list = byNormalized.get(normalized) ?? [];
      list.push(candidate);
      byNormalized.set(normalized, list);
    }
    return Array.from(byNormalized.entries()).map(([normalized, list]) => ({
      normalized,
      candidates: list,
    }));
  }

  private normalize(value: NameValue): string {
    if (typeof value === 'string') return value.trim().toLowerCase();
    return String(value);
  }

  private pickRepresentative(group: ValueGroup): NameCandidate {
    return orderBy(group.candidates, ['lastUpdated', 'priority'], ['desc', 'desc'])[0];
  }

  // ─── normalizedName: the trigram key, rebuilt from the picked names ─────

  /**
   * Keeps the key in step with the names picked above; before this it only
   * changed on creation, admin edits, splits and the backfill script. Strips
   * the resolved brand's name rather than a source's scraped brand string, so
   * the key doesn't depend on how one shop spells the brand. Products the
   * scraper loads carry no brand relation, so when no brand was resolved
   * above the old key stays — as it does when there's no name to build from.
   */
  private recomputeNormalizedName(
    model: ProductModel,
    categorySlug: string | undefined,
  ): void {
    const brandName = model.brand?.name;
    if (!brandName) return;

    const strategy =
      this.categoryConfigService.getConfig(categorySlug)
        ?.normalizationStrategy ?? 'full-sorted';
    try {
      model.normalizedName = this.productNormalizer.normalizeProduct({
        brand: brandName,
        model: model.model,
        displayName: model.displayName,
        strategy,
      });
    } catch (error: unknown) {
      this.logger.warn('Kept the old normalizedName', {
        modelId: model.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Aliases: union, not corroboration-gated ────────────────────────────

  private async mergeAliases(
    model: ProductModel,
    sources: ProductSourceRecord[],
    manager?: EntityManager,
  ): Promise<void> {
    // A product not inserted yet has no row for an alias to point at. The
    // scraper that is creating it inserts the listing's aliases itself, right
    // after the first save.
    if (!model.id) return;

    const candidateAliases = new Set<string>();
    for (const record of sources) {
      for (const alias of record.scrapedProduct?.aliases ?? []) {
        if (alias) candidateAliases.add(alias);
      }
    }
    if (candidateAliases.size === 0) return;

    const existing = model.aliases ?? [];
    const existingTexts = new Set([
      model.displayName,
      model.normalizedName,
      ...existing.map((a) => a.alias),
    ]);

    for (const alias of candidateAliases) {
      if (existingTexts.has(alias)) continue;
      await this.tryCreateAlias(alias, model.id, manager);
    }
  }

  private async tryCreateAlias(
    alias: string,
    modelId: string,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      const newAlias = new ProductAlias();
      newAlias.alias = alias;
      newAlias.source = ProductAliasSource.scraped;
      newAlias.model = { id: modelId } as ProductModel;
      await this.aliasRepo.save(newAlias, undefined, manager);
    } catch (error: unknown) {
      // Unique constraint violation — alias already exists, skip
      this.logger.debug('Skipped duplicate alias', { alias, modelId });
    }
  }
}
