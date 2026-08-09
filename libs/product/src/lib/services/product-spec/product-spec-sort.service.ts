import { Injectable } from "@nestjs/common";
import {
  OrderedSpec,
  ProductCategory,
  ProductSpecs,
  UnitFormat,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import _ from "lodash";

@Injectable()
export class ProductSpecSortService {
  constructor(private readonly categoryConfigService: CategoryConfigService) {}

  /**
   * Sort specs using category JSON schema with parent fallback.
   */
  public sortSpecs(
    category: ProductCategory,
    specs: ProductSpecs,
  ): OrderedSpec[] {
    if (!category?.slug) return [];
    const schema = this.categoryConfigService.getJsonSchema(category.slug);
    const properties = schema?.properties ?? {};
    const specKeys = Object.keys(specs ?? {});
    if (!specKeys.length) return [];

    //
    // Build array of defined specs with order
    //
    const defined = _.map(properties, (def, key) => ({
      key,
      title: def.title ?? key,
      order: def.meta?.order,
      unit: def.meta?.unit,
      unitFormat: def.meta?.unitFormat,
    }));

    //
    // Sort with: ordered first → then alphabetical fallback
    //
    const sortedDefinitions = _.sortBy(defined, [
      (d) => (_.isNil(d.order) ? Number.MAX_SAFE_INTEGER : d.order),
      "key",
    ]);

    //
    // Keep only those defined in schema *and* present in specs
    //
    const ordered: OrderedSpec[] = sortedDefinitions
      .filter((d) => specs[d.key] !== undefined)
      .map((d) => ({
        key: d.key,
        label: d.title,
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
    const valueStr = value?.toString() ?? "";
    if (!unit) return valueStr;

    return unitFormat === "none" ? `${valueStr}${unit}` : `${valueStr} ${unit}`;
  }
}
