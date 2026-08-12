import { Injectable } from '@nestjs/common';
import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

import {
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';

export interface SpecValidationResult {
  isValid: boolean;
  errors: Record<string, any>;
}

@Injectable()
export class ProductSpecValidatorService {
  private readonly ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  /**
   * Main validation function
   */
  public validateSpecs(
    schema: SpecDefinitionJsonSchema | undefined,
    specs: ProductSpecs,
  ): SpecValidationResult {
    if (!schema) {
      return { isValid: true, errors: {} };
    }

    const validate = this.ajv.compile(schema);

    const valid = validate(specs);

    if (valid) {
      return { isValid: true, errors: {} };
    }

    return {
      isValid: false,
      errors: this.formatErrors(validate.errors || []),
    };
  }

  /**
   * Make error output readable:
   * { "weight": ["must be number"], "brand": ["is required"] }
   */
  private formatErrors(errors: ErrorObject[]): Record<string, string[]> {
    const output: Record<string, string[]> = {};

    for (const err of errors) {
      const key =
        err.instancePath.replace(/^\//, '') || err.params['missingProperty'];
      if (!key) continue;

      const message = err.message || 'Invalid value';
      if (!output[key]) output[key] = [];

      output[key].push(message);
    }

    return output;
  }
}
