import { Injectable } from '@nestjs/common';
import { ProductAlias, ProductAliasSource, ProductModel, ProductSource, ProductSourceRecord } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { orderBy } from 'lodash';
import { BrandResolutionService } from '../resolution/brand-resolution.service';
import { EntityManager } from 'typeorm';
import { ProductAliasRepository } from '@fittkereso-backend/database';

type IdentityValue = string | number;

interface IdentityCandidate {
  value: IdentityValue;
  priority: number;
  lastUpdated: Date;
}

interface ValueGroup {
  normalized: string;
  candidates: IdentityCandidate[];
}

/**
 * Recomputes ProductModel's identity fields (brand/model/displayName/
 * releaseYear/aliases) from its ProductSourceRecords — the identity-field
 * counterpart to ProductSpecMergeService, called from
 * ProductMergeService.mergeSources alongside the spec merge. Uses the same
 * corroboration-then-recency/priority tiebreak shape as
 * ProductSpecMergeService.resolveKey's Tier 2/4, simplified since identity
 * fields are single scalars, not schema-typed/numeric — there's no
 * schema-plausibility filter or numeric-precision tiebreak here.
 */
@Injectable()
export class ProductIdentityMergeService {
  private readonly logger = new CustomLogger(ProductIdentityMergeService.name);

  constructor(
    private readonly brandResolution: BrandResolutionService,
    private readonly aliasRepo: ProductAliasRepository,
  ) {}

  public async mergeIdentity(
    model: ProductModel,
    latestPerSource: ProductSourceRecord[],
    manager?: EntityManager,
  ): Promise<void> {
    const brandWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.brand,
    );
    const modelWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.model,
    );
    const displayNameWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.displayName,
    );
    const releaseYearWinner = this.resolveField(
      latestPerSource,
      (r) => r.scrapedProduct?.releaseYear,
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
    if (releaseYearWinner !== undefined) {
      model.releaseYear = Number(releaseYearWinner);
    }

    await this.mergeAliases(model, latestPerSource, manager);
  }

  // ─── Per-field resolution (corroboration, then recency/priority) ───────

  private resolveField(
    sources: ProductSourceRecord[],
    extract: (record: ProductSourceRecord) => IdentityValue | undefined,
  ): IdentityValue | undefined {
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
    extract: (record: ProductSourceRecord) => IdentityValue | undefined,
  ): IdentityCandidate[] {
    const candidates: IdentityCandidate[] = [];
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

  private groupByValue(candidates: IdentityCandidate[]): ValueGroup[] {
    const byNormalized = new Map<string, IdentityCandidate[]>();
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

  private normalize(value: IdentityValue): string {
    if (typeof value === 'string') return value.trim().toLowerCase();
    return String(value);
  }

  private pickRepresentative(group: ValueGroup): IdentityCandidate {
    return orderBy(group.candidates, ['lastUpdated', 'priority'], ['desc', 'desc'])[0];
  }

  // ─── Aliases: union, not corroboration-gated ────────────────────────────

  private async mergeAliases(
    model: ProductModel,
    sources: ProductSourceRecord[],
    manager?: EntityManager,
  ): Promise<void> {
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
