import { Injectable } from "@nestjs/common";
import Ajv from "ajv";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class AiSchemaValidatorService {
  private readonly logger = new CustomLogger(AiSchemaValidatorService.name);

  /**
   * Validate raw LLM JSON content against the schema.
   * Always strips extra properties and runs ajv.
   *
   * When `strict` is true: throws on any validation failure, letting the
   * caller's retry logic handle it.
   * When `strict` is false (default): coerces invalid enum values to the last
   * allowed value and fills missing required enum fields before validating.
   */
  validateAndSanitize(
    rawContent: string,
    schema: any,
    strict = false,
  ): { sanitized: string; parsed: any } {
    const cleaned = rawContent
      ?.replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned || "{}");

    this.stripExtraProperties(parsed, schema);

    if (!strict) {
      this.coerceEnumValues(parsed, schema);
      this.fillMissingEnumDefaults(parsed, schema);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    if (!validate(parsed)) {
      this.logger.error("Schema validation failed", undefined, {
        errors: validate.errors,
        rawContent,
        parsed,
      });
      throw new Error("Invalid response schema from AI provider");
    }

    return { sanitized: JSON.stringify(parsed), parsed };
  }

  private coerceEnumValues(data: any, schema: any): void {
    if (!data || !schema) return;

    if (Array.isArray(data)) {
      const itemSchema = schema.items;
      if (!itemSchema) return;

      if (itemSchema.enum) {
        const allowed: string[] = itemSchema.enum;
        const fallback = allowed[allowed.length - 1];
        for (let i = 0; i < data.length; i++) {
          if (!allowed.includes(data[i])) {
            this.logger.warn(
              `Coercing invalid enum value "${data[i]}" to "${fallback}"`,
            );
            data[i] = fallback;
          }
        }
        return;
      }

      for (const item of data) {
        this.coerceEnumValues(item, itemSchema);
      }
      return;
    }

    if (typeof data === "object" && schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties) as [
        string,
        any,
      ][]) {
        if (data[key] === undefined || data[key] === null) continue;

        if (propSchema.enum) {
          const allowed: string[] = propSchema.enum;
          const fallback = allowed[allowed.length - 1];
          if (!allowed.includes(data[key])) {
            this.logger.warn(
              `Coercing invalid enum value "${data[key]}" to "${fallback}"`,
            );
            data[key] = fallback;
          }
        } else {
          this.coerceEnumValues(data[key], propSchema);
        }
      }
    }
  }

  private fillMissingEnumDefaults(data: any, schema: any): void {
    if (!data || typeof data !== "object" || !schema) return;

    if (Array.isArray(data)) {
      const itemSchema = schema.items;
      if (itemSchema) {
        for (const item of data) {
          this.fillMissingEnumDefaults(item, itemSchema);
        }
      }
      return;
    }

    if (schema.properties) {
      const required: string[] = schema.required ?? [];
      for (const [key, propSchema] of Object.entries(schema.properties) as [
        string,
        any,
      ][]) {
        if (
          data[key] === undefined &&
          required.includes(key) &&
          propSchema.enum
        ) {
          const fallback = propSchema.enum[propSchema.enum.length - 1];
          this.logger.warn(
            `Filling missing required enum field "${key}" with "${fallback}"`,
          );
          data[key] = fallback;
        } else if (data[key] !== undefined && data[key] !== null) {
          this.fillMissingEnumDefaults(data[key], propSchema);
        }
      }
    }
  }

  private stripExtraProperties(data: any, schema: any): void {
    if (!data || typeof data !== "object" || !schema) return;

    if (Array.isArray(data)) {
      const itemSchema = schema.items;
      if (itemSchema) {
        for (const item of data) {
          this.stripExtraProperties(item, itemSchema);
        }
      }
      return;
    }

    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = Object.keys(schema.properties);
      for (const key of Object.keys(data)) {
        if (!allowedKeys.includes(key)) {
          delete data[key];
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (data[key] !== undefined && data[key] !== null) {
          this.stripExtraProperties(data[key], propSchema);
        }
      }
    }
  }
}
