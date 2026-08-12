import { Injectable } from '@nestjs/common';
import {
  ProductSpecs,
  SpecValueTranslator,
} from '@fittkereso-backend/database';
import { compact } from 'lodash';
import {
  ProductSpecMapping,
  ScrapedProductSpec,
} from '@fittkereso-backend/product';

@Injectable()
export class ProductValueMapperService {
  // ---------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------

  public mapSingleValueOrFail(opts: MappingOptions): string {
    const value = this.mapSingleValue(opts);
    if (!value) {
      throw new Error(`Missing required spec: ${opts.label}`);
    }
    return value;
  }

  public mapSingleValue({
    specs,
    label,
    transformer,
    translator,
    toLowerCase,
    removeWhiteSpace,
  }: MappingOptions): string | undefined {
    const raw = this.getFirstRawValue(specs, label);
    return raw
      ? this.applyPipeline(raw, {
          transformer,
          translator,
          toLowerCase,
          removeWhiteSpace,
        })
      : undefined;
  }

  public mapNumber(opts: MappingOptions): number | undefined {
    const str = this.mapSingleValue(opts);
    if (!str) return undefined;

    const num = Number(str);
    return Number.isFinite(num) ? num : undefined;
  }

  public mapListValue({
    specs,
    label,
    translator,
    toLowerCase,
    removeWhiteSpace,
  }: MappingOptions): string[] | undefined {
    const rawValues = this.getRawValues(specs, label);
    if (!rawValues?.length) return undefined;

    const transformed = compact(
      rawValues.map((v) =>
        this.applyPipeline(v, { translator, toLowerCase, removeWhiteSpace }),
      ),
    );

    return transformed.length ? transformed : undefined;
  }

  public mapValues({
    specs,
    mappings,
    translator,
  }: {
    specs: ScrapedProductSpec[] | undefined;
    mappings: ProductSpecMapping[];
    translator?: SpecValueTranslator;
  }): ProductSpecs {
    if (!specs) return {};

    const result: ProductSpecs = {};

    for (const mapping of mappings) {
      if (!mapping.key) continue;

      const opts: MappingOptions = {
        specs,
        label: '',
        transformer: mapping.transformer,
        translator,
        toLowerCase: mapping.toLowerCase,
        removeWhiteSpace: mapping.removeWhiteSpace,
      };

      if (mapping.listValue) {
        const allValues = compact(
          mapping.labels
            .map((label) => this.mapListValue({ ...opts, label }))
            .flat(),
        );

        if (allValues.length > 0) {
          result[mapping.key] = Array.from(new Set(allValues));
        }
      } else {
        const value = mapping.labels
          .map((label) => this.mapSingleValue({ ...opts, label }))
          .find((v) => v !== undefined);

        if (value !== undefined && value !== '') {
          result[mapping.key] = value;
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------

  private getFirstRawValue(
    specs: ScrapedProductSpec[],
    label: string,
  ): string | undefined {
    const spec = this.findSpec(specs, label);
    return spec?.values?.[0]?.trim() || undefined;
  }

  private getRawValues(
    specs: ScrapedProductSpec[],
    label: string,
  ): string[] | undefined {
    const spec = this.findSpec(specs, label);
    if (!spec?.values) return undefined;

    const cleaned = spec.values
      .map((v) => v?.trim())
      .filter((v) => v && v !== '') as string[];

    return cleaned.length ? cleaned : undefined;
  }

  private findSpec(
    specs: ScrapedProductSpec[],
    label: string,
  ): ScrapedProductSpec | undefined {
    return specs.find((s) => s.name.toLowerCase() === label.toLowerCase());
  }

  // ---------------------------------------------------------------
  // CENTRALIZED PIPELINE
  // ---------------------------------------------------------------

  private applyPipeline(
    value: string,
    {
      transformer,
      translator,
      toLowerCase,
      removeWhiteSpace,
    }: Partial<MappingOptions>,
  ): string | undefined {
    let v: string | undefined = value;

    if (transformer) {
      v = transformer(v);
      if (!v) return undefined;
    }

    if (translator) {
      v = translator(v);
    }

    if (toLowerCase && v) {
      v = v.toLowerCase();
    }

    if (removeWhiteSpace && v) {
      v = v.replace(/\s+/g, '');
    }

    return v?.trim() || undefined;
  }
}

// ---------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------

export interface MappingOptions {
  specs: ScrapedProductSpec[];
  label: string;
  transformer?: (value: string) => string | undefined;
  translator?: SpecValueTranslator;
  toLowerCase?: boolean;
  removeWhiteSpace?: boolean;
}
