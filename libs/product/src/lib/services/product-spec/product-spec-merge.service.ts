import { Injectable } from '@nestjs/common';
import {
  ProductSourceRecord,
  ProductSource,
  ProductSourceRepository,
  ProductSpecs,
  SpecDefinitionProperty,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { chain, isBoolean, isEmpty, isNumber, orderBy } from 'lodash';

type SpecValue = string | number | boolean | string[];

interface SpecCandidate {
  value: SpecValue;
  sourceLabel: string;
  priority: number;
  lastUpdated: Date;
}

interface ValueGroup {
  /** Normalized comparison key — not itself returned as the resolved value. */
  normalized: string;
  candidates: SpecCandidate[];
}

/**
 * Merges per-source specs into one ProductModel.specs object across an
 * arbitrary, unranked set of sources — no source is assumed to be generally
 * more trustworthy than another (a shop can have the best value for one spec
 * and a wrong one for the next), so resolution runs per spec key through four
 * tiers, cheapest/most-reliable signal first:
 *
 *  Tier 1 — disqualify candidate values that are structurally implausible
 *           (out of the schema's meta.min/max range, or not one of a closed
 *           set in the schema's enum) before they can outvote a correct value.
 *  Tier 2 — corroboration: the value the most distinct sources agree on wins.
 *           This is the primary signal — it needs no per-source trust model,
 *           only agreement.
 *  Tier 3 — numeric precision: among values tied on corroboration, prefer a
 *           more decimal-precise one PROVIDED it's within the coarser value's
 *           rounding tolerance ("43.2" beats a tied "43"; "17.6" vs a tied
 *           "17" is real disagreement, not precision, and falls through
 *           unresolved — see resolvePrecision for the tolerance check).
 *  Tier 4 — last-resort tiebreak: most recently scraped value wins, then
 *           ProductSource.priority (an explicit per-source override an
 *           operator can still set when they know better — see the entity
 *           doc comment — but it only decides ties tiers 1-3 couldn't).
 *
 * A key with only one source's value skips straight through with nothing to
 * arbitrate — most of a 100+-key category schema is this case, since
 * per-source coverage of any individual field is typically sparse.
 */
@Injectable()
export class ProductSpecMergeService {
  private readonly logger = new CustomLogger(ProductSpecMergeService.name);
  private sources: ProductSource[] = [];

  constructor(
    private readonly sourceRepo: ProductSourceRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async mergeSpecs(
    sourceSpecs: ProductSourceRecord[],
    categorySlug?: string | null,
  ): Promise<ProductSpecs> {
    await this.loadSourcesIfNeeded(sourceSpecs);

    const jsonSchema = this.categoryConfigService.getJsonSchema(categorySlug);
    const candidatesByKey = this.buildCandidates(sourceSpecs);

    const merged: ProductSpecs = {};
    for (const [key, candidates] of candidatesByKey) {
      merged[key] = this.resolveKey(key, candidates, jsonSchema?.properties[key]);
    }

    return chain(merged).toPairs().sortBy(0).fromPairs().value() as ProductSpecs;
  }

  // ─── Candidate collection ───────────────────────────────────────────────

  private buildCandidates(
    sourceSpecs: ProductSourceRecord[],
  ): Map<string, SpecCandidate[]> {
    const byKey = new Map<string, SpecCandidate[]>();

    for (const record of sourceSpecs) {
      const priority =
        this.sources.find((source) => source.id === record.source?.id)
          ?.priority ?? 0;
      const sourceLabel =
        record.source?.name ?? record.scrapedProduct?.displayName ?? record.id;

      for (const [key, value] of Object.entries(
        record.scrapedProduct?.specs ?? {},
      )) {
        if (!this.isValueDefined(value)) continue;

        const list = byKey.get(key) ?? [];
        list.push({
          value: value as SpecValue,
          sourceLabel,
          priority,
          lastUpdated: record.lastUpdated,
        });
        byKey.set(key, list);
      }
    }

    return byKey;
  }

  private isValueDefined(value: unknown): boolean {
    return isBoolean(value) || isNumber(value) || !isEmpty(value);
  }

  // ─── Per-key resolution (Tiers 1-4) ─────────────────────────────────────

  private resolveKey(
    key: string,
    candidates: SpecCandidate[],
    propSchema: SpecDefinitionProperty | undefined,
  ): SpecValue {
    if (candidates.length === 1) {
      return candidates[0].value;
    }

    // Tier 1: drop structurally implausible candidates. Fails open — if the
    // bounds would disqualify every candidate, keep the full pool instead of
    // silently dropping the key; meta.min/max is an advisory guard against
    // unit/transcription errors, not a hard guarantee of category coverage.
    const qualified = candidates.filter((c) =>
      this.passesTier1(c.value, propSchema),
    );
    const disqualified = candidates.length - qualified.length;
    if (disqualified > 0 && qualified.length > 0) {
      this.logger.debug(
        `Tier 1 dropped ${disqualified} implausible candidate(s) for "${key}"`,
        {
          key,
          dropped: candidates
            .filter((c) => !this.passesTier1(c.value, propSchema))
            .map((c) => `${c.sourceLabel}=${c.value}`),
        },
      );
    }
    const pool = qualified.length > 0 ? qualified : candidates;

    // Tier 2: group by normalized value, keep only the group(s) tied for the
    // most distinct-source agreement.
    const groups = this.groupByValue(pool);
    const maxCount = Math.max(...groups.map((g) => g.candidates.length));
    let tied = groups.filter((g) => g.candidates.length === maxCount);

    // Tier 3: numeric-only. Collapses a precision-only split (17 vs 17.9) into
    // the more precise group; leaves a genuine value disagreement (17.6 vs
    // 17.9) untouched, to fall through to Tier 4.
    if (tied.length > 1 && propSchema?.type === 'number') {
      tied = this.resolvePrecision(tied);
    }

    if (tied.length > 1) {
      this.logger.debug(
        `Unresolved conflict for "${key}" — ${tied.length} values tied on corroboration, breaking by recency/priority`,
        {
          key,
          candidates: tied.map(
            (g) => `${g.candidates.length}x ${g.candidates[0].value}`,
          ),
        },
      );
    }

    const representatives = tied.map((g) => this.pickRepresentative(g));
    return orderBy(representatives, ['lastUpdated', 'priority'], ['desc', 'desc'])[0]
      .value;
  }

  private passesTier1(
    value: SpecValue,
    propSchema: SpecDefinitionProperty | undefined,
  ): boolean {
    if (!propSchema) return true;

    if (propSchema.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      const { min, max } = propSchema.meta ?? {};
      if (min !== undefined && n < min) return false;
      if (max !== undefined && n > max) return false;
      return true;
    }

    if (propSchema.type === 'string' && propSchema.enum?.length) {
      // Case/whitespace-insensitive, matching groupByValue's normalization —
      // a stray-cased or padded value that still names a real option (shop
      // formatting noise) must reach Tier 2 to be corroborated, not get
      // silently discarded here before Tier 2 ever sees it.
      if (typeof value !== 'string') return false;
      const normalizedOptions = propSchema.enum.map((o) => this.normalize(o));
      return normalizedOptions.includes(this.normalize(value));
    }

    return true;
  }

  private groupByValue(candidates: SpecCandidate[]): ValueGroup[] {
    const byNormalized = new Map<string, SpecCandidate[]>();
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

  private normalize(value: SpecValue): string {
    if (typeof value === 'string') return value.trim().toLowerCase();
    if (Array.isArray(value))
      return [...value].map((v) => v.trim().toLowerCase()).sort().join('|');
    return String(value);
  }

  /**
   * Looks for a pair of tied numeric groups where the coarser value is within
   * the rounding tolerance of the more precise one at its own decimal count
   * (e.g. frameSize "43" vs "43.2" — 0.2 is within ±0.5 of 0-decimal
   * rounding, so they're the same measurement at different precision). When
   * found, the more precise group wins outright. A pair that's merely close
   * (e.g. "17" vs "17.6" — 0.6 exceeds the ±0.5 tolerance a 0-decimal
   * rounding could produce) is real disagreement, not precision, and is left
   * for Tier 4 to break instead.
   */
  private resolvePrecision(tied: ValueGroup[]): ValueGroup[] {
    for (const a of tied) {
      for (const b of tied) {
        if (a === b) continue;
        const av = Number(a.candidates[0].value);
        const bv = Number(b.candidates[0].value);
        const aDecimals = this.decimalPlaces(av);
        const bDecimals = this.decimalPlaces(bv);
        if (aDecimals === bDecimals) continue;

        const [more, moreVal, fewerVal, fewerDecimals] =
          aDecimals > bDecimals ? [a, av, bv, bDecimals] : [b, bv, av, aDecimals];

        const roundingTolerance = 0.5 * Math.pow(10, -fewerDecimals);
        if (Math.abs(moreVal - fewerVal) < roundingTolerance) {
          return [more];
        }
      }
    }
    return tied;
  }

  private decimalPlaces(n: number): number {
    const s = String(n);
    const i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  }

  private pickRepresentative(group: ValueGroup): SpecCandidate {
    return orderBy(group.candidates, ['lastUpdated', 'priority'], ['desc', 'desc'])[0];
  }

  // ─── Source priority cache ──────────────────────────────────────────────

  private async loadSourcesIfNeeded(
    sourceSpecs: ProductSourceRecord[],
  ): Promise<void> {
    if (!this.isLoadingNeeded(sourceSpecs)) {
      return;
    }

    this.sources = await this.sourceRepo.getAll();
  }

  private isLoadingNeeded(sourceSpecs: ProductSourceRecord[]): boolean {
    return (
      this.sources.length === 0 ||
      sourceSpecs.some(
        (spec) =>
          spec.source?.id &&
          !this.sources.find((source) => source.id === spec.source?.id),
      )
    );
  }
}
