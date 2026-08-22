import { Injectable } from '@nestjs/common';
import {
  OrderedSpec,
  ProductSpecs,
  UnitFormat,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import _ from 'lodash';

@Injectable()
export class ProductSpecSortService {
  constructor(private readonly categoryConfigService: CategoryConfigService) {}

  /**
   * Sort specs using the category's JSON schema, with unrecognized keys
   * falling back after the schema-ordered ones. Takes categorySlug directly
   * (not a ProductCategory entity) so callers can't accidentally break
   * ordering by passing a partially-loaded/stubbed entity that's missing
   * `slug` — see ProductMergeService.mergeSources.
   */
  public sortSpecs(
    categorySlug: string | undefined,
    specs: ProductSpecs,
  ): OrderedSpec[] {
    if (!categorySlug) return [];
    const schema = this.categoryConfigService.getJsonSchema(categorySlug);
    const properties = schema?.properties ?? {};
    const specKeys = Object.keys(specs ?? {});
    if (!specKeys.length) return [];

    //
    // Build array of defined specs with order
    //
    const defined = _.map(properties, (def, key) => ({
      key,
      title: def.title ?? key,
      translation: def.translation,
      order: def.meta?.order,
      unit: def.meta?.unit,
      unitFormat: def.meta?.unitFormat,
    }));

    //
    // Sort with: ordered first → then alphabetical fallback
    //
    const sortedDefinitions = _.sortBy(defined, [
      (d) => (_.isNil(d.order) ? Number.MAX_SAFE_INTEGER : d.order),
      'key',
    ]);

    //
    // Keep only those defined in schema *and* present in specs
    //
    const ordered: OrderedSpec[] = sortedDefinitions
      .filter((d) => specs[d.key] !== undefined)
      .map((d) => ({
        key: d.key,
        label: d.translation ?? d.title,
        translation: d.translation,
        value: this.formatSpecValue(specs[d.key], d.unit, d.unitFormat),
      }));

    //
    // Remaining keys not in schema
    //
    const leftoverKeys = _.difference(
      specKeys,
      sortedDefinitions.map((d) => d.key),
    );

    const additional = _.sortBy(leftoverKeys).map((key) => ({
      key,
      label: _.startCase(key),
      value: specs[key],
    }));

    return [...ordered, ...additional];
  }

  /**
   * Format spec value with unit (e.g., "100 MHz").
   */
  private formatSpecValue(
    value: unknown,
    unit?: string,
    unitFormat?: UnitFormat,
  ): string {
    const valueStr = value?.toString() ?? '';
    if (!unit) return valueStr;

    return unitFormat === 'none' ? `${valueStr}${unit}` : `${valueStr} ${unit}`;
  }
}
