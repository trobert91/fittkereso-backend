import { Injectable } from "@nestjs/common";
import {
  ProductSpecs,
  SourceSpecConfig,
  SourceSpecMapping,
  SpecDefinitionJsonSchema,
  SpecExtractMode,
  SpecValueTranslator,
  CalculatedSpecRule,
} from "@ebike-backend/database";
import type { ScrapedProductSpec } from "../../models/scraped-product";
import { ProductSpecNormalizationService } from "./product-spec-normalization.service";
import { compact } from "lodash";

@Injectable()
export class SpecExtractionService {
  constructor(
    private readonly specNormalizer: ProductSpecNormalizationService,
  ) {}

  public extractSpecs(params: {
    scrapedSpecs: ScrapedProductSpec[] | undefined;
    schema: SpecDefinitionJsonSchema;
    sourceConfig: SourceSpecConfig;
    translator?: SpecValueTranslator;
  }): ProductSpecs {
    const { scrapedSpecs, schema, sourceConfig, translator } = params;
    if (!scrapedSpecs) return {};

    const mapped = this.mapFromConfig(
      scrapedSpecs,
      sourceConfig.mappings,
      translator,
    );

    const calculated = this.evaluateCalculated(
      scrapedSpecs,
      mapped,
      sourceConfig.calculated ?? [],
      translator,
    );

    const combined = { ...mapped, ...calculated };

    return this.specNormalizer.normalize(combined, schema);
  }

  // ─── Mapping ────────────────────────────────────────────────────────────────

  private mapFromConfig(
    specs: ScrapedProductSpec[],
    mappings: SourceSpecMapping[],
    translator?: SpecValueTranslator,
  ): ProductSpecs {
    const result: ProductSpecs = {};

    for (const mapping of mappings) {
      const fetchAllValues =
        mapping.extract === "list" ||
        mapping.extract === "standardRatio" ||
        mapping.extract === "regexpList" ||
        mapping.extract === "shuffledList";
      const rawValue = this.findRawValue(
        specs,
        mapping.labels,
        fetchAllValues,
        mapping.preferredValueIndex,
        mapping.sectionTitle,
      );

      if (rawValue === undefined) continue;
      if (this.shouldSkipValue(rawValue, mapping.skipValues)) continue;

      const remapped = this.applyValueMap(rawValue, mapping.valueMap);
      const translated =
        remapped !== undefined
          ? remapped
          : this.translateValue(rawValue, translator);
      const trimmed = this.applyTrimSuffixes(translated, mapping.trimSuffixes);
      const replaced = this.applyReplacePatterns(
        trimmed,
        mapping.replacePatterns,
      );
      result[mapping.key] = this.applyExtractMode(
        replaced,
        mapping.extract,
        mapping.extractPatterns,
      );
    }

    return result;
  }

  /**
   * Deterministic pre-translation value remap. Returns the mapped canonical
   * value(s) when the raw value is fully covered by `valueMap`, or `undefined`
   * to signal the caller should fall through to the translator. Matching is
   * case-insensitive. For array values, only fully-covered arrays short-circuit
   * — partial coverage falls through so mixed content still gets translated.
   */
  private applyValueMap(
    value: string | string[],
    valueMap: Record<string, string> | undefined,
  ): string | string[] | undefined {
    if (!valueMap) return undefined;

    const lowercased: Record<string, string> = {};
    for (const [key, mapped] of Object.entries(valueMap)) {
      lowercased[key.toLowerCase()] = mapped;
    }

    if (Array.isArray(value)) {
      const mapped = value.map((item) => lowercased[item.toLowerCase()]);
      if (mapped.some((item) => item === undefined)) return undefined;
      return mapped as string[];
    }

    return lowercased[value.toLowerCase()];
  }

  private findRawValue(
    specs: ScrapedProductSpec[],
    labels: string[],
    isList: boolean,
    preferredValueIndex?: number,
    sectionTitle?: string,
  ): string | string[] | undefined {
    for (const label of labels) {
      const spec = specs.find(
        (specItem) =>
          specItem.name.toLowerCase() === label.toLowerCase() &&
          (!sectionTitle ||
            specItem.sectionTitle?.toLowerCase() ===
              sectionTitle.toLowerCase()),
      );
      if (!spec?.values?.length) continue;

      if (isList) {
        const filtered = compact(spec.values.map((value) => value.trim()));
        return filtered.length > 0 ? filtered : undefined;
      }

      const index =
        preferredValueIndex !== undefined &&
        preferredValueIndex < spec.values.length
          ? preferredValueIndex
          : 0;

      const selectedValue = spec.values[index]?.trim();
      return selectedValue || undefined;
    }

    return undefined;
  }

  private translateValue(
    value: string | string[],
    translator?: SpecValueTranslator,
  ): string | string[] {
    if (!translator) return value;

    if (Array.isArray(value)) {
      return value.map((item) => translator(item) ?? item);
    }

    return translator(value) ?? value;
  }

  private shouldSkipValue(
    value: string | string[],
    skipValues?: string[],
  ): boolean {
    if (!skipValues?.length) return false;

    const valuesToCheck = Array.isArray(value) ? value : [value];
    return valuesToCheck.every((item) =>
      skipValues.some(
        (skip) => item.toLowerCase().trim() === skip.toLowerCase(),
      ),
    );
  }

  private applyTrimSuffixes(
    value: string | string[],
    suffixes?: string[],
  ): string | string[] {
    if (!suffixes?.length || Array.isArray(value)) return value;

    let result = value;
    for (const suffix of suffixes) {
      result = result.replace(new RegExp(`\\s*${suffix}\\s*$`, "i"), "").trim();
    }
    return result;
  }

  private applyReplacePatterns(
    value: string | string[],
    patterns?: Array<{ from: string; to: string }>,
  ): string | string[] {
    if (!patterns?.length || Array.isArray(value)) return value;

    let result = value;
    for (const { from, to } of patterns) {
      result = result.split(from).join(to);
    }
    return result;
  }

  private applyExtractMode(
    value: string | string[],
    mode?: SpecExtractMode,
    extractPatterns?: string[],
  ): string | number | string[] | undefined {
    if (mode === "shuffledList") return this.extractShuffledList(value);
    if (mode === "standardRatio") return this.extractStandardRatio(value);
    if (mode === "regexpList")
      return this.extractRegexpList(value, extractPatterns);
    if (mode === "cmToInchList") return this.extractCmToInchList(value);
    if (mode === "mmToCmAndInchList")
      return this.extractMmToCmAndInchList(value);
    if (mode === "list") return this.extractList(value);
    if (Array.isArray(value)) return value;
    if (!mode || mode === "raw") return value;

    switch (mode) {
      case "number":
        return this.extractFirstNumber(value);

      case "secondNumber":
        return this.extractSecondNumber(value);

      case "roundedNumber": {
        const number = this.extractFirstNumber(value);
        return number !== undefined ? Math.round(number) : undefined;
      }

      case "ceiledNumber": {
        const number = this.extractFirstNumber(value);
        return number !== undefined ? Math.ceil(number) : undefined;
      }

      case "removeWhitespace":
        return value.replace(/\s+/g, "");

      default:
        return value;
    }
  }

  private extractList(value: string | string[]): string[] | undefined {
    const items = Array.isArray(value) ? value : [value];
    const split = items.flatMap((item) =>
      item.split(",").map((part) => part.trim()),
    );
    const cleaned = compact(split);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private extractShuffledList(value: string | string[]): string[] | undefined {
    const items = Array.isArray(value)
      ? value
      : compact(value.split(",").map((item) => item.trim()));
    const cleaned = compact(
      items.map((item) => item.replace(/\s*\(.*?\)\s*/g, "").trim()),
    );
    if (cleaned.length === 0) return undefined;

    for (let i = cleaned.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cleaned[i], cleaned[j]] = [cleaned[j], cleaned[i]];
    }
    return cleaned;
  }

  private extractStandardRatio(value: string | string[]): string | undefined {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const tokens = candidate.split(/[\s/]+/).map((token) => token.trim());
      const match = tokens.find((token) => /^\d+:\d+$/.test(token));
      if (match) return match;
    }
    return undefined;
  }

  private extractRegexpList(
    value: string | string[],
    patterns?: string[],
  ): string[] | undefined {
    if (!patterns?.length) return undefined;

    const candidates = Array.isArray(value) ? value : [value];
    const results: string[] = [];

    for (const pattern of patterns) {
      const regex = new RegExp(pattern, "i");

      for (const candidate of candidates) {
        const match = candidate.match(regex);
        if (!match) continue;

        const groups = match.slice(1);
        const output = groups
          .map((group) => this.roundIfNumeric(group))
          .join(" ");

        results.push(output);
        break;
      }
    }

    return results.length > 0 ? results : undefined;
  }

  private extractMmToCmAndInchList(
    value: string | string[],
  ): string[] | undefined {
    const MM_PER_INCH = 25.4;
    const MM_PER_CM = 10;
    const candidate = Array.isArray(value) ? value[0] : value;
    const match = candidate?.match(/([\d.]+)\s*mm/i);
    if (!match) return undefined;

    const mm = parseFloat(match[1]);
    if (!Number.isFinite(mm)) return undefined;

    const cm = Math.round((mm / MM_PER_CM) * 100) / 100;
    const inches = Math.round((mm / MM_PER_INCH) * 100) / 100;
    return [`${cm} cm`, `${inches} in`];
  }

  private extractCmToInchList(value: string | string[]): string[] | undefined {
    const CM_PER_INCH = 2.54;
    const candidate = Array.isArray(value) ? value[0] : value;
    const match = candidate?.match(/([\d.]+)\s*cm/i);
    if (!match) return undefined;

    const cm = parseFloat(match[1]);
    if (!Number.isFinite(cm)) return undefined;

    const inches = Math.round((cm / CM_PER_INCH) * 100) / 100;
    return [`${cm} cm`, `${inches} in`];
  }

  private roundIfNumeric(value: string): string {
    const number = parseFloat(value);
    if (!Number.isFinite(number)) return value;

    const rounded = Math.round(number * 100) / 100;
    return String(rounded);
  }

  // ─── Calculated Specs ───────────────────────────────────────────────────────

  private evaluateCalculated(
    specs: ScrapedProductSpec[],
    mapped: ProductSpecs,
    rules: CalculatedSpecRule[],
    translator?: SpecValueTranslator,
  ): ProductSpecs {
    const result: ProductSpecs = {};

    for (const rule of rules) {
      switch (rule.rule) {
        case "presentIfKey":
          result[rule.key] = mapped[rule.source as string] !== undefined;
          break;

        case "featureSearch":
          result[rule.key] = this.evaluateFeatureSearch(
            specs,
            rule.source as string,
            rule.keywords ?? [],
          );
          break;

        case "presentLabels":
          result[rule.key] = this.evaluatePresentLabels(
            specs,
            rule.source as string[],
            translator,
          );
          break;
      }
    }

    return result;
  }

  private evaluateFeatureSearch(
    specs: ScrapedProductSpec[],
    sourceLabel: string,
    keywords: string[],
  ): boolean {
    const spec = specs.find(
      (specItem) => specItem.name.toLowerCase() === sourceLabel.toLowerCase(),
    );
    const values = spec?.values ?? [];

    return values.some((value) =>
      keywords.some((keyword) =>
        value.toLowerCase().includes(keyword.toLowerCase()),
      ),
    );
  }

  private evaluatePresentLabels(
    specs: ScrapedProductSpec[],
    labels: string[],
    translator?: SpecValueTranslator,
  ): string[] | undefined {
    const presentLabels: string[] = [];

    for (const label of labels) {
      const spec = specs.find(
        (specItem) => specItem.name.toLowerCase() === label.toLowerCase(),
      );
      if (!spec?.values?.[0]) continue;

      const rawValue = spec.values[0].toLowerCase().trim();
      const translated = translator ? translator(rawValue) : rawValue;

      if (translated === "yes") {
        presentLabels.push(label);
      }
    }

    return presentLabels.length > 0 ? presentLabels : undefined;
  }

  // ─── Number Extraction ──────────────────────────────────────────────────────

  private extractFirstNumber(value: string): number | undefined {
    const match = value.match(/-?\d+(\.\d+)?/);
    if (!match) return undefined;

    const number = Number(match[0]);
    return Number.isFinite(number) ? number : undefined;
  }

  private extractSecondNumber(value: string): number | undefined {
    const matches = value.match(/[\d.]+/g);
    if (!matches) return undefined;

    const index = matches.length >= 2 ? 1 : 0;
    const number = parseFloat(matches[index]);
    return Number.isFinite(number) ? number : undefined;
  }
}
