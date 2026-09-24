import { Injectable } from '@nestjs/common';
import { ProductAlias, ProductAliasSource, ProductModel, ProductSource, ProductSourceRecord } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { orderBy } from 'lodash';
import { BrandResolutionService } from '../brand/brand-resolution.service';
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
 * plus the normalizedName key built from them) from its
 * ProductSourceRecords — the name-field counterpart to
 * ProductSpecMergeService, called from ProductMergeService.mergeSources
 * alongside the spec merge. Uses the same corroboration-then-recency/priority
 * tiebreak shape as ProductSpecMergeService.resolveKey's Tier 2/4, simplified
 * since name fields are single scalars, not schema-typed/numeric — there's no
 * schema-plausibility filter or numeric-precision tiebreak here.
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

  public async mergeNames(
    model: ProductModel,
    latestPerSource: ProductSourceRecord[],
    categorySlug: string | undefined,
    manager?: EntityManager,
  ): Promise<void> {
    const brandWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.brand,
    );
    // A name the identity extraction did not clean (it failed, or is off for
    // that source) is the raw title — sizes, colours, marketing words. It only
    // names the product when no source has a cleaned one. Records from before
    // the flag existed carry none, and were cleaned by the old pass.
    const cleaned = latestPerSource.filter(
      (r) => r.scrapedProduct?.nameCleaned !== false,
    );
    const nameSources = cleaned.length > 0 ? cleaned : latestPerSource;
    const modelWinner = this.resolveField(
      nameSources,
      (r) => r.scrapedProduct?.model,
    );
    const displayNameWinner = this.resolveField(
      nameSources,
      (r) => r.scrapedProduct?.displayName,
    );

    if (brandWinner !== undefined) {
      const resolved = await this.brandResolution.resolve(
        String(brandWinner),
        displayNameWinner !== undefined ? String(displayNameWinner) : undefined,
      );
      if (resolved?.entity) {
        model.brand = resolved.entity;
      }
    }
    if (modelWinner !== undefined) {
      model.model = String(modelWinner);
    }
    if (displayNameWinner !== undefined) {
      model.displayName = String(displayNameWinner);
    }

    // Before the alias merge, which skips aliases equal to the key.
    this.recomputeNormalizedName(model, categorySlug);
    await this.mergeAliases(model, latestPerSource, manager);
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
