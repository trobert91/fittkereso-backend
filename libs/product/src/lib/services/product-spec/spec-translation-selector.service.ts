import { Injectable } from '@nestjs/common';
import {
  SourceSpecConfig,
  SourceSpecMapping,
  SpecExtractMode,
} from '@fittkereso-backend/database';
import { ScrapedProductSpec } from '../../models/scraped-product';

// Extract modes that produce a number or structured numeric output. Values
// fed into these modes don't benefit from translation — the number is parsed
// out of the raw source-language string directly (e.g. "99 g" -> 99).
const NUMERIC_EXTRACT_MODES: ReadonlySet<SpecExtractMode> = new Set<SpecExtractMode>(
  [
    'number',
    'secondNumber',
    'roundedNumber',
    'ceiledNumber',
    'cmToInchList',
    'mmToCmAndInchList',
    'standardRatio',
  ],
);

// Promoted out of ArukeresoDetailsPageExtractor as part of the declarative
// scraping migration — this logic was source-agnostic already (it only reads
// a SourceSpecConfig), it just lived inside one source's extractor class.
@Injectable()
export class SpecTranslationSelectorService {
  /**
   * Collect raw spec values that actually benefit from translation. Skips:
   *   - Specs whose label is not referenced by any mapping (they never make it
   *     into the final ProductSpecs, so translating is pure waste)
   *   - Specs whose mapping uses a numeric extract mode — the number is
   *     parsed from the raw string directly, translation adds nothing
   *   - Values covered by the mapping's `valueMap` — those are resolved
   *     deterministically at extract time and bypass translation entirely
   */
  public collectTranslatableValues(
    extractedSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
  ): string[] {
    if (!sourceConfig) return [];

    const mappingsByLabel = new Map<string, SourceSpecMapping>();
    for (const mapping of sourceConfig.mappings) {
      if (mapping.extract && NUMERIC_EXTRACT_MODES.has(mapping.extract))
        continue;
      for (const label of mapping.labels) {
        mappingsByLabel.set(label.toLowerCase(), mapping);
      }
    }

    const values: string[] = [];
    for (const spec of extractedSpecs) {
      const mapping = mappingsByLabel.get(spec.name.toLowerCase());
      if (!mapping) continue;
      if (!spec.values) continue;

      const valueMapKeys = mapping.valueMap
        ? new Set(Object.keys(mapping.valueMap).map((key) => key.toLowerCase()))
        : undefined;

      for (const value of spec.values) {
        if (!value) continue;
        if (valueMapKeys && valueMapKeys.has(value.toLowerCase())) continue;
        values.push(value);
      }
    }
    return values;
  }
}
