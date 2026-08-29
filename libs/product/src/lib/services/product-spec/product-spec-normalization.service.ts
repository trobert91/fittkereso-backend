import { Injectable } from '@nestjs/common';
import {
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';

@Injectable()
export class ProductSpecNormalizationService {
  normalize(
    specs: ProductSpecs,
    schema: SpecDefinitionJsonSchema,
  ): ProductSpecs {
    if (!schema || !schema.properties) return specs;

    const result: ProductSpecs = {};

    for (const [key, prop] of Object.entries(schema.properties)) {
      const rawValue = specs[key];

      // skip undefined
      if (rawValue === undefined || rawValue === null) {
        continue;
      }

      switch (prop.type) {
        case 'number':
          result[key] = this.toNumber(rawValue);
          break;

        case 'boolean':
          result[key] = this.toBoolean(rawValue);
          break;

        case 'string': {
          const stringValue = this.toStringValue(rawValue);
          // Enum fields: a raw/LLM value that doesn't name one of the
          // allowed options is dropped rather than persisted verbatim —
          // same "can't confirm, so omit" rule applied elsewhere to missing
          // spec values, extended to values that are present but invalid.
          // Without this, a source's raw label sails through untouched
          // whenever nothing (deterministic mapping or LLM) rewrites it,
          // even though it was never a member of the field's own enum.
          if (prop.enum?.length && !this.isEnumMember(stringValue, prop.enum)) {
            break;
          }
          result[key] = stringValue;
          break;
        }

        case 'array':
          result[key] = this.toArray(rawValue, prop);
          break;

        // case 'object':
        //   result[key] = this.toObject(rawValue);
        //   break;

        default:
          result[key] = rawValue;
      }
    }

    return result;
  }

  // --------------------------
  // TYPE NORMALIZERS
  // --------------------------

  /**
   * Number conversion (Mode B):
   * Extract the first number from the value.
   */
  private toNumber(value: any): number | undefined {
    if (typeof value === 'number') return value;

    const str = String(value);
    const match = str.match(/-?\d+(\.\d+)?/); // first number
    if (!match) return undefined;

    const n = Number(match[0]);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * Boolean conversion (Mode A):
   * Accept only "true" / "false" or real booleans.
   */
  private toBoolean(value: any): boolean | undefined {
    if (typeof value === 'boolean') return value;

    const str = String(value).trim().toLowerCase();
    switch (str) {
      case 'true':
      case 'yes':
      case 'y':
      case '1':
        return true;
      case 'false':
      case 'no':
      case 'n':
      case '0':
        return false;
    }

    return undefined;
  }

  /** Case/whitespace-insensitive enum membership check — mirrors
   *  ProductSpecMergeService's own enum-matching convention. */
  private isEnumMember(value: string, enumValues: string[]): boolean {
    const normalized = value.trim().toLowerCase();
    return enumValues.some((option) => option.trim().toLowerCase() === normalized);
  }

  private toStringValue(value: any): string {
    if (Array.isArray(value)) {
      return value.length === 1 ? String(value[0]) : value.join(', ');
    }
    return String(value).trim();
  }

  /**
   * Array conversion:
   * - Always return an array because the schema says type = "array"
   * - If it's scalar, wrap in array
   * - If it's array, normalize each item based on element type (string only for now)
   */
  private toArray(value: any, prop: any): string[] {
    const arr = Array.isArray(value) ? value : [value];
    return arr
      .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
      .filter((v) => v !== '');
  }

  private toObject(value: any): Record<string, any> | undefined {
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return undefined;
  }
}
