import { Injectable } from '@nestjs/common';
import {
  CategoryMatchingConfig,
  NumericTokenRule,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  basicNormalization as sharedBasicNormalization,
  removeBrand as sharedRemoveBrand,
  parseTokens,
  getTokenWeights as sharedGetTokenWeights,
  TokenParserConfig,
} from '@fittkereso-backend/product';
import { isEmpty } from 'lodash';
import { MatchingConfigService } from './matching-config.service';
import type { ProductResolutionInput } from '../models/resolution-input';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CategoryMatchConfig {
  strictness: 'strict' | 'moderate' | 'loose';
  numericTokenRules: Array<{
    pattern: RegExp;
    weight: number;
    description: string;
    critical: boolean;
  }>;
  matcherSpecHierarchies?: Record<string, Record<string, string[]>>;
  primarySpecs?: string[];
  matcherSpecs?: string[];
  maxMatcherSpecMismatches?: number;
}

export interface ParsedModelCode {
  words: string[];
  raw: string;
  valid: boolean;
  numericCount: number;
  criticalNumericTokens: string[];
  criticalAlphaTokens: string[];
  /** Pure-alpha tokens that appear after the first numeric token (e.g. "cqp" in "mag341cqp"). */
  suffixAlphaTokens: string[];
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class InputNormalizationService {
  private readonly configCache = new Map<string, CategoryMatchConfig>();

  constructor(
    private readonly matchingConfig: MatchingConfigService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  getCategoryConfig(category?: {
    id: string;
    slug?: string;
  }): CategoryMatchConfig {
    if (!category) return this.getDefaultConfig();

    const cacheKey = category.id;
    const cached = this.configCache.get(cacheKey);
    if (cached) return cached;

    if (!category.slug) return this.getDefaultConfig();
    const fullCategoryConfig = this.categoryConfigService.getConfig(
      category.slug,
    );
    const categoryConfig = fullCategoryConfig?.matchingConfig;
    const runtimeConfig = !isEmpty(categoryConfig)
      ? this.buildRuntimeConfig(
          categoryConfig,
          fullCategoryConfig?.matcherSpecHierarchies,
          fullCategoryConfig?.primarySpecs,
          fullCategoryConfig?.matcherSpecs,
        )
      : this.getDefaultConfig();

    this.configCache.set(cacheKey, runtimeConfig);
    return runtimeConfig;
  }

  private buildRuntimeConfig(
    config: CategoryMatchingConfig,
    matcherSpecHierarchies?: Record<string, Record<string, string[]>>,
    primarySpecs?: string[],
    matcherSpecs?: string[],
  ): CategoryMatchConfig {
    return {
      strictness: config.strictness ?? 'moderate',
      numericTokenRules: (config.numericTokenRules ?? []).map(
        (rule: NumericTokenRule) => ({
          pattern: new RegExp(rule.pattern, 'i'),
          weight: rule.weight,
          description: rule.description,
          critical: rule.critical,
        }),
      ),
      matcherSpecHierarchies,
      primarySpecs,
      matcherSpecs,
      maxMatcherSpecMismatches: config.maxMatcherSpecMismatches,
    };
  }

  private getDefaultConfig(): CategoryMatchConfig {
    const mc = this.matchingConfig.config;
    return {
      strictness: mc.defaultStrictness,
      numericTokenRules: [
        {
          pattern: /\d+/,
          weight: mc.defaultNumericTokenWeight,
          description: 'Any numeric token',
          critical: false,
        },
      ],
    };
  }

  // ─── Normalization ─────────────────────────────────────────────────────────

  /**
   * Normalize input for matching.
   * Compares displayName vs model length AFTER brand removal to avoid picking
   * a longer raw string that becomes shorter after stripping.
   */
  normalizeForMatching(
    input: ProductResolutionInput,
    config: CategoryMatchConfig,
  ): string {
    const modelText = input.model || '';
    const displayText = input.displayName || '';

    if (!modelText && !displayText) return '';

    const strippedModel = this.removeBrand(modelText, input.brand);
    const strippedDisplay = this.removeBrand(displayText, input.brand);

    const text =
      strippedDisplay.length >= strippedModel.length
        ? strippedDisplay
        : strippedModel;

    if (!text) return '';

    return this.basicNormalization(text);
  }

  /**
   * Basic text normalization.
   * Collapses whitespace between letter-groups and digit-groups so
   * "MPG 341CQPX" normalizes the same as "MPG341CQPX".
   */
  basicNormalization(text: string): string {
    return sharedBasicNormalization(text);
  }

  private removeBrand(text: string, brand: string | undefined): string {
    return sharedRemoveBrand(text, brand);
  }

  // ─── Parsing ───────────────────────────────────────────────────────────────

  /**
   * Parse a normalized model code into tokens with critical token detection.
   */
  parseModelCode(
    normalized: string,
    config: CategoryMatchConfig,
  ): ParsedModelCode {
    const tokenParserConfig: TokenParserConfig = {
      numericTokenRules: config.numericTokenRules,
    };
    return parseTokens(normalized, tokenParserConfig);
  }

  // ─── Token Weights ─────────────────────────────────────────────────────────

  getTokenWeights(words: string[], config: CategoryMatchConfig): number[] {
    return sharedGetTokenWeights(words, {
      numericTokenRules: config.numericTokenRules,
    });
  }
}
