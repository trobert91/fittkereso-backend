import { Injectable } from "@nestjs/common";
import { CategoryConfigService } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { isEmpty } from "lodash";
import {
  TokenParserConfig,
  ParsedTokens,
  basicNormalization,
  removeBrand,
  parseTokens,
} from "./token-parser";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ParsedName {
  raw: string;
  normalized: string;
  parsed: ParsedTokens;
}

export interface NormalizedNameLists {
  queryNames: ParsedName[];
  candidateNames: ParsedName[];
  tokenConfig: TokenParserConfig;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SimilarityInputNormalizationService {
  private readonly configCache = new Map<string, TokenParserConfig>();
  private readonly hierarchyCache = new Map<
    string,
    Record<string, Record<string, string[]>> | undefined
  >();
  private readonly primarySpecsCache = new Map<string, string[] | undefined>();
  private readonly matcherSpecsCache = new Map<string, string[] | undefined>();

  constructor(
    private readonly categoryConfigService: CategoryConfigService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  /**
   * Build normalized, parsed name lists from raw product data.
   * Handles: brand removal, name normalization, token parsing, config loading.
   */
  buildNameLists(params: {
    query: { model: string; displayName?: string; aliases?: string[] };
    candidate: { model: string; displayName?: string; aliases?: string[] };
    brandName?: string;
    categorySlug?: string;
  }): NormalizedNameLists {
    const { query, candidate, brandName, categorySlug } = params;
    const tokenConfig = this.getCategoryTokenConfig(categorySlug);

    const queryNames = this.buildSideNames(
      query.model,
      query.displayName,
      query.aliases,
      brandName,
      tokenConfig,
    );

    const candidateNames = this.buildSideNames(
      candidate.model,
      candidate.displayName,
      candidate.aliases,
      brandName,
      tokenConfig,
    );

    return { queryNames, candidateNames, tokenConfig };
  }

  /**
   * Load and cache category-specific token rules.
   * Falls back to default config when no category is provided or category has no matching config.
   */
  getCategoryTokenConfig(categorySlug?: string): TokenParserConfig {
    if (!categorySlug) return this.getDefaultConfig();

    const cached = this.configCache.get(categorySlug);
    if (cached) return cached;

    const fullCategoryConfig =
      this.categoryConfigService.getConfig(categorySlug);
    const matchingConfig = fullCategoryConfig?.matchingConfig;

    const numericTokenRules = matchingConfig?.numericTokenRules;
    if (!numericTokenRules || numericTokenRules.length === 0) {
      const defaultConfig = this.getDefaultConfig();
      this.configCache.set(categorySlug, defaultConfig);
      return defaultConfig;
    }

    const tokenConfig: TokenParserConfig = {
      numericTokenRules: numericTokenRules.map(
        (rule: { pattern: string; weight: number; critical: boolean }) => ({
          pattern: new RegExp(rule.pattern, "i"),
          weight: rule.weight,
          critical: rule.critical,
        }),
      ),
    };

    this.configCache.set(categorySlug, tokenConfig);
    return tokenConfig;
  }

  /**
   * Load and cache category-specific spec hierarchies for spec comparison.
   */
  getMatcherSpecHierarchies(
    categorySlug?: string,
  ): Record<string, Record<string, string[]>> | undefined {
    if (!categorySlug) return undefined;

    if (this.hierarchyCache.has(categorySlug)) {
      return this.hierarchyCache.get(categorySlug);
    }

    const fullCategoryConfig =
      this.categoryConfigService.getConfig(categorySlug);
    const hierarchies = fullCategoryConfig?.matcherSpecHierarchies;
    this.hierarchyCache.set(categorySlug, hierarchies);
    return hierarchies;
  }

  /**
   * Load and cache category-specific primary specs for spec comparison.
   */
  getPrimarySpecs(categorySlug?: string): string[] | undefined {
    if (!categorySlug) return undefined;

    if (this.primarySpecsCache.has(categorySlug)) {
      return this.primarySpecsCache.get(categorySlug);
    }

    const fullCategoryConfig =
      this.categoryConfigService.getConfig(categorySlug);
    const primarySpecs = fullCategoryConfig?.primarySpecs;
    this.primarySpecsCache.set(categorySlug, primarySpecs);
    return primarySpecs;
  }

  /**
   * Load and cache category-specific matcher specs for spec comparison.
   */
  getMatcherSpecs(categorySlug?: string): string[] | undefined {
    if (!categorySlug) return undefined;

    if (this.matcherSpecsCache.has(categorySlug)) {
      return this.matcherSpecsCache.get(categorySlug);
    }

    const fullCategoryConfig =
      this.categoryConfigService.getConfig(categorySlug);
    const matcherSpecs = fullCategoryConfig?.matcherSpecs;
    this.matcherSpecsCache.set(categorySlug, matcherSpecs);
    return matcherSpecs;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private buildSideNames(
    model: string,
    displayName: string | undefined,
    aliases: string[] | undefined,
    brandName: string | undefined,
    tokenConfig: TokenParserConfig,
  ): ParsedName[] {
    const rawNames = [model, displayName, ...(aliases ?? [])].filter(
      (name): name is string => !isEmpty(name),
    );

    const seen = new Set<string>();
    const parsedNames: ParsedName[] = [];

    for (const raw of rawNames) {
      const stripped = removeBrand(raw, brandName);
      const normalized = basicNormalization(stripped);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      const parsed = parseTokens(normalized, tokenConfig);
      if (!parsed.valid) continue;

      parsedNames.push({ raw, normalized, parsed });
    }

    return parsedNames;
  }

  private getDefaultConfig(): TokenParserConfig {
    const defaultWeight =
      this.dynamicConfigService.resolution?.matching
        ?.defaultNumericTokenWeight ?? 2.5;

    return {
      numericTokenRules: [
        {
          pattern: /\d+/,
          weight: defaultWeight,
          critical: false,
        },
      ],
    };
  }
}
