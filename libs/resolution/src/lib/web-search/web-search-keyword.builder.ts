import { Injectable } from '@nestjs/common';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { StructuredSpec } from '@fittkereso-backend/database';
import { compact } from 'lodash';
import type { ResolutionContext } from '../models/resolution-context';
import type { WebQueryIntent } from '../models/search-evidence';

const CROSS_MARKET_REGIONS = 'US EU UK';

/**
 * Deterministic SERP-query compiler.
 *
 * One builder, one method `build(intent, ctx)`. The four supported intents map
 * to four query shapes:
 *
 *  - `exact_model`            — `"<brand> <model>"` + suffix
 *  - `model_with_specs`       — `"<brand> <model>" <spec values…>` + suffix
 *  - `reference_sibling_sku`  — `"<ref-brand> <ref-model>" <modelClues>
 *                                <inputSpecs> <variantClues>` + suffix
 *  - `cross_market`           — `"<brand> <model>" equivalent model name
 *                                US EU UK` + suffix
 *
 * The suffix comes from `CategoryPromptConfig.searchKeywordSuffix` for
 * `ctx.referenceProduct.productCategory.slug` (or any candidate's slug as a
 * fallback). Same construction the identification LLM used to do free-text in
 * v1, but reproducible, cacheable, and unit-testable.
 */
@Injectable()
export class WebSearchKeywordBuilder {
  constructor(private readonly categoryConfigService: CategoryConfigService) {}

  build(
    intent: WebQueryIntent,
    context: ResolutionContext,
  ): string | undefined {
    const categorySlug = this.resolveCategorySlug(context);
    switch (intent) {
      case 'exact_model':
        return this.buildExactModel(context, categorySlug);
      case 'model_with_specs':
        return this.buildModelWithSpecs(context, categorySlug);
      case 'reference_sibling_sku':
        return this.buildReferenceSiblingSku(context, categorySlug);
      case 'cross_market':
        return this.buildCrossMarket(context, categorySlug);
    }
  }

  // ─── Per-intent builders ───────────────────────────────────────────────────

  private buildExactModel(
    context: ResolutionContext,
    categorySlug: string | undefined,
  ): string | undefined {
    const suffix = this.resolveSuffix(categorySlug);
    const quoted = quoteBrandModel(context.input.brand, context.input.model);
    if (!quoted) return undefined;
    return compact([quoted, suffix]).join(' ');
  }

  private buildModelWithSpecs(
    context: ResolutionContext,
    categorySlug: string | undefined,
  ): string | undefined {
    const suffix = this.resolveSuffix(categorySlug);
    const quoted = quoteBrandModel(context.input.brand, context.input.model);
    if (!quoted) return undefined;
    const specValues = firstSpecValues(
      context.effectiveMatchSpecs ?? context.input.specs,
      2,
    );
    return compact([quoted, specValues, suffix]).join(' ');
  }

  private buildReferenceSiblingSku(
    context: ResolutionContext,
    categorySlug: string | undefined,
  ): string | undefined {
    const suffix = this.resolveSuffix(categorySlug);
    const reference = context.referenceProduct;
    const refBrand = reference?.brand ?? context.input.brand;
    const refModel = reference?.model ?? context.input.referenceModel;
    const quoted = quoteBrandModel(refBrand, refModel);
    if (!quoted) return undefined;

    const modelClues = (context.input.modelClues ?? []).filter(
      (clue) => clue.length > 0,
    );
    const variantClues = (context.input.variantClues ?? []).filter(
      (clue) => clue.length > 0,
    );
    const specValues = firstSpecValues(context.input.specs, 2);

    return compact([
      quoted,
      modelClues.join(' '),
      specValues,
      variantClues.join(' '),
      suffix,
    ]).join(' ');
  }

  private buildCrossMarket(
    context: ResolutionContext,
    categorySlug: string | undefined,
  ): string | undefined {
    const suffix = this.resolveSuffix(categorySlug);
    const brand = context.brand?.name ?? context.input.brand;
    const model = context.input.model;
    if (!brand || !model) return undefined;
    return compact([
      `"${brand} ${model}"`,
      `equivalent model name ${CROSS_MARKET_REGIONS}`,
      suffix,
    ]).join(' ');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private resolveCategorySlug(context: ResolutionContext): string | undefined {
    const referenceSlug = context.referenceProduct?.productCategory?.slug;
    if (referenceSlug) return referenceSlug;
    for (const candidate of context.candidates) {
      const slug = candidate.productCategory?.slug;
      if (slug) return slug;
    }
    return undefined;
  }

  private resolveSuffix(categorySlug: string | undefined): string | undefined {
    if (!categorySlug) return undefined;
    const config = this.categoryConfigService.getConfig(categorySlug);
    const suffix = config?.promptConfig?.searchKeywordSuffix;
    return suffix && suffix.length > 0 ? suffix : undefined;
  }
}

function quoteBrandModel(
  brand: string | undefined,
  model: string | undefined | null,
): string | undefined {
  const trimmedBrand = brand?.trim();
  const trimmedModel = model?.trim();
  if (trimmedBrand && trimmedModel) {
    return `"${trimmedBrand} ${trimmedModel}"`;
  }
  if (trimmedModel) {
    return `"${trimmedModel}"`;
  }
  if (trimmedBrand) {
    return `"${trimmedBrand}"`;
  }
  return undefined;
}

function firstSpecValues(
  specs: StructuredSpec[] | Record<string, unknown> | undefined,
  n: number,
): string | undefined {
  if (!specs) return undefined;
  const values: string[] = [];

  if (Array.isArray(specs)) {
    for (const spec of specs.slice(0, n)) {
      if (spec.value) values.push(spec.value);
    }
  } else {
    for (const [, value] of Object.entries(specs).slice(0, n)) {
      if (value == null) continue;
      const str = String(value);
      if (str.length > 0) values.push(str);
    }
  }
  return values.length > 0 ? values.join(' ') : undefined;
}
