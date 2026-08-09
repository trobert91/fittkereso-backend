import { Injectable } from '@nestjs/common';
import {
  DynamicConfigData,
  dynamicConfigSchema,
} from './models/dynamic-config-data.interface';
import Ajv, { ErrorObject } from 'ajv';

@Injectable()
export class DynamicConfigValidatorService {
  private readonly ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  public validateOrThrowError(data: DynamicConfigData) {
    const validate = this.ajv.compile(dynamicConfigSchema);
    const valid = validate(data);

    if (!valid) {
      throw new Error(
        `Invalid dynamic config data: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
}
